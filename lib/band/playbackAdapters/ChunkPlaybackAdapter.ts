import type { FourStemPcm } from "../../separation/stemTypes.ts";
import {
  DEMUCS_STRIDE_SAMPLES,
  type SeparationChunkRecord,
  computeTotalChunks,
  getChunkRecord,
  unpackBufferToChunkStems,
} from "../../storage/separationChunkStore.ts";
import type { SoundTouchBufferLike } from "./SoundTouchAdapter.ts";

export type ChunkMixStemRole = "vocals" | "drums" | "bass" | "other" | "instrumental";

export interface ChunkMixTrackEntry {
  trackId: string;
  role: ChunkMixStemRole;
  gain: number;
  muted: boolean;
}

interface ResidentChunkEntry {
  chunkIndex: number;
  startSample: number;
  endSample: number;
  frameCount: number;
  payloadBytes: number;
  peakAbs: number;
  stems: FourStemPcm;
  lastUsedSeq: number;
}

export interface ChunkedStemMixBufferOptions {
  taskId: string;
  totalSamples: number;
  sampleRate: number;
  entries: ChunkMixTrackEntry[];
  stemLayout?: "four_stem" | "two_stem_direct";
  strideSamples?: number;
  maxResidentChunks?: number;
  loop?: boolean;
  loadChunk?: (taskId: string, chunkIndex: number) => Promise<SeparationChunkRecord | null>;
}

export const DEFAULT_MAX_RESIDENT_PLAYBACK_CHUNKS = 6;

/**
 * 分段按需混音緩衝（Sliding-Window Chunk Cache + Streaming Mixdown）：
 * - 符合 `SoundTouchBufferLike` 介面，可直接接入 `SoundTouchAdapter`；
 * - 同一時間僅將少數相鄰 Chunk（預設上限 6 段 ≈ 47 MiB）常駐記憶體；
 * - 4 軌模式與 2 軌模式共用 4 軌 IndexedDB Chunk（2 軌 `instrumental` 於 `extract` 時即時加總 drums+bass+other）。
 */
export class ChunkedStemMixBuffer implements SoundTouchBufferLike {
  readonly numberOfChannels = 2;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  readonly taskId: string;
  readonly strideSamples: number;
  readonly totalChunks: number;
  readonly maxResidentChunks: number;
  readonly entries: ChunkMixTrackEntry[];
  readonly stemLayout: "four_stem" | "two_stem_direct";

  private readonly loadChunkFn: (
    taskId: string,
    chunkIndex: number,
  ) => Promise<SeparationChunkRecord | null>;
  private readonly resident = new Map<number, ResidentChunkEntry>();
  private readonly inFlight = new Map<number, Promise<ResidentChunkEntry | null>>();
  private lruCounter = 0;
  private lastPositionChunk = 0;
  private loopEnabled: boolean;
  private disposed = false;
  private residentPeakAbs = 0;
  private missingChunkCount = 0;
  private lastLoadError: string | null = null;

  constructor(options: ChunkedStemMixBufferOptions) {
    this.taskId = options.taskId;
    this.length = Math.max(0, Math.floor(options.totalSamples));
    this.sampleRate = options.sampleRate > 0 ? options.sampleRate : 44100;
    this.duration = this.sampleRate > 0 ? this.length / this.sampleRate : 0;
    this.strideSamples = options.strideSamples ?? DEMUCS_STRIDE_SAMPLES;
    this.totalChunks = computeTotalChunks(this.length, this.strideSamples);
    this.maxResidentChunks = Math.max(3, options.maxResidentChunks ?? DEFAULT_MAX_RESIDENT_PLAYBACK_CHUNKS);
    this.entries = options.entries;
    this.stemLayout = options.stemLayout ?? "four_stem";
    this.loopEnabled = Boolean(options.loop);
    this.loadChunkFn = options.loadChunk ?? getChunkRecord;
  }

  setLoopEnabled(loop: boolean): void {
    this.loopEnabled = loop;
    if (loop && this.totalChunks > 0) {
      void this.ensureChunkLoaded(0);
    }
  }

  getResidentChunkIndices(): number[] {
    return Array.from(this.resident.keys()).sort((a, b) => a - b);
  }

  getDiagnostics(): {
    taskId: string;
    totalChunks: number;
    residentChunks: number[];
    residentPeakAbs: number;
    activeEntryCount: number;
    missingChunkCount: number;
    lastLoadError: string | null;
  } {
    return {
      taskId: this.taskId,
      totalChunks: this.totalChunks,
      residentChunks: this.getResidentChunkIndices(),
      residentPeakAbs: this.residentPeakAbs,
      activeEntryCount: this.entries.filter((e) => !e.muted && e.gain > 0).length,
      missingChunkCount: this.missingChunkCount,
      lastLoadError: this.lastLoadError,
    };
  }

  private recomputeResidentPeakAbs(): void {
    let peak = 0;
    for (const entry of this.resident.values()) {
      if (entry.peakAbs > peak) peak = entry.peakAbs;
    }
    this.residentPeakAbs = peak;
  }

  getEstimatedResidentBytes(): number {
    let total = 0;
    for (const entry of this.resident.values()) {
      total += entry.payloadBytes;
    }
    return total;
  }

  chunkIndexForSample(samplePos: number): number {
    if (this.totalChunks <= 0) return 0;
    const clamped = Math.max(0, Math.min(this.length - 1, Math.floor(samplePos)));
    return Math.min(this.totalChunks - 1, Math.floor(clamped / this.strideSamples));
  }

  /**
   * 預熱並等待指定播放位置附近必要視窗（當前、前 1、後 2、Loop 時含第 0 段），
   * 讓 play() 或 seek() 後第一個音訊回呼即可命中記憶體。
   */
  async warmUpAroundSample(samplePos: number): Promise<void> {
    if (this.disposed || this.totalChunks === 0) return;
    const center = this.chunkIndexForSample(samplePos);
    this.lastPositionChunk = center;
    const targets = new Set<number>();
    for (const delta of [0, 1, -1, 2]) {
      const idx = center + delta;
      if (idx >= 0 && idx < this.totalChunks) targets.add(idx);
    }
    if (this.loopEnabled) {
      targets.add(0);
    }
    await Promise.all(Array.from(targets, (idx) => this.ensureChunkLoaded(idx)));
    this.evictExcessChunks(center);
  }

  private async ensureChunkLoaded(chunkIndex: number): Promise<ResidentChunkEntry | null> {
    if (this.disposed || chunkIndex < 0 || chunkIndex >= this.totalChunks) return null;
    const existing = this.resident.get(chunkIndex);
    if (existing) {
      existing.lastUsedSeq = ++this.lruCounter;
      return existing;
    }
    const pending = this.inFlight.get(chunkIndex);
    if (pending) return pending;

    const loadPromise = (async () => {
      try {
        const rec = await this.loadChunkFn(this.taskId, chunkIndex);
        if (this.disposed) return null;
        if (!rec) {
          this.missingChunkCount += 1;
          return null;
        }
        const frameCount = rec.endSample - rec.startSample;
        if (frameCount <= 0) {
          this.missingChunkCount += 1;
          return null;
        }
        const stems = unpackBufferToChunkStems(rec.payload, frameCount);
        const view = new Float32Array(rec.payload);
        let peakAbs = 0;
        for (let i = 0; i < view.length; i++) {
          const abs = view[i] < 0 ? -view[i] : view[i];
          if (abs > peakAbs) peakAbs = abs;
        }
        const residentEntry: ResidentChunkEntry = {
          chunkIndex,
          startSample: rec.startSample,
          endSample: rec.endSample,
          frameCount,
          payloadBytes: rec.payload.byteLength,
          peakAbs,
          stems,
          lastUsedSeq: ++this.lruCounter,
        };
        this.resident.set(chunkIndex, residentEntry);
        this.evictExcessChunks(this.lastPositionChunk);
        this.recomputeResidentPeakAbs();
        return residentEntry;
      } catch (err) {
        this.lastLoadError = err instanceof Error ? err.message : String(err);
        return null;
      } finally {
        this.inFlight.delete(chunkIndex);
      }
    })();

    this.inFlight.set(chunkIndex, loadPromise);
    return loadPromise;
  }

  private evictExcessChunks(anchorChunk: number): void {
    if (this.resident.size <= this.maxResidentChunks) return;
    const protectedSet = new Set<number>([
      anchorChunk - 1,
      anchorChunk,
      anchorChunk + 1,
      anchorChunk + 2,
    ]);
    if (this.loopEnabled) protectedSet.add(0);

    while (this.resident.size > this.maxResidentChunks) {
      let victimKey: number | null = null;
      let victimSeq = Infinity;
      for (const [idx, entry] of this.resident.entries()) {
        if (protectedSet.has(idx)) continue;
        if (entry.lastUsedSeq < victimSeq) {
          victimSeq = entry.lastUsedSeq;
          victimKey = idx;
        }
      }
      if (victimKey === null) {
        // 若幾乎全為保護視窗內段落，依純 LRU 淘汰非 anchor 本身的最舊段
        for (const [idx, entry] of this.resident.entries()) {
          if (idx === anchorChunk) continue;
          if (entry.lastUsedSeq < victimSeq) {
            victimSeq = entry.lastUsedSeq;
            victimKey = idx;
          }
        }
      }
      if (victimKey === null) break;
      this.resident.delete(victimKey);
    }
    this.recomputeResidentPeakAbs();
  }

  getChannelData(channel: number): Float32Array {
    // 僅回傳與已駐留 Chunk 對應的樣本片段（或短曲完整合成），維持相容性
    const out = new Float32Array(this.length);
    const activeEntries = this.entries.filter((e) => !e.muted && e.gain > 0);
    if (activeEntries.length === 0) return out;
    for (const chunk of this.resident.values()) {
      for (const entry of activeEntries) {
        const gain = entry.gain;
        if (entry.role === "instrumental") {
          if (this.stemLayout === "two_stem_direct") {
            const direct = channel === 0 ? chunk.stems.drums.left : chunk.stems.drums.right;
            for (let i = 0; i < chunk.frameCount; i++) {
              out[chunk.startSample + i] += direct[i] * gain;
            }
          } else {
            const d = channel === 0 ? chunk.stems.drums.left : chunk.stems.drums.right;
            const b = channel === 0 ? chunk.stems.bass.left : chunk.stems.bass.right;
            const o = channel === 0 ? chunk.stems.other.left : chunk.stems.other.right;
            for (let i = 0; i < chunk.frameCount; i++) {
              out[chunk.startSample + i] += (d[i] + b[i] + o[i]) * gain;
            }
          }
        } else {
          const srcPair = chunk.stems[entry.role];
          const src = channel === 0 ? srcPair.left : srcPair.right;
          for (let i = 0; i < chunk.frameCount; i++) {
            out[chunk.startSample + i] += src[i] * gain;
          }
        }
      }
    }
    return out;
  }

  /**
   * 同步提供 interleaved stereo PCM 給 SoundTouch SimpleFilter，並觸發後續滑動視窗非同步預載。
   */
  extract(target: Float32Array, numFrames = 0, position = 0): number {
    const startPos = Math.max(0, Math.floor(position));
    const available = Math.max(0, Math.min(numFrames, this.length - startPos));
    target.fill(0, 0, numFrames * 2);
    if (this.disposed || available <= 0 || this.totalChunks === 0) {
      return available;
    }

    const activeEntries = this.entries.filter((e) => !e.muted && e.gain > 0);
    const startChunk = this.chunkIndexForSample(startPos);
    const endChunk = this.chunkIndexForSample(startPos + available - 1);
    this.lastPositionChunk = startChunk;

    // 背景滑動視窗預載（當前 + 下一段 + 再下一段 + Loop 起點）
    for (let c = startChunk; c <= Math.min(this.totalChunks - 1, endChunk + 2); c++) {
      if (!this.resident.has(c)) {
        void this.ensureChunkLoaded(c);
      }
    }
    if (this.loopEnabled && !this.resident.has(0)) {
      void this.ensureChunkLoaded(0);
    }

    for (let c = startChunk; c <= endChunk; c++) {
      const chunk = this.resident.get(c);
      if (!chunk) continue;
      chunk.lastUsedSeq = ++this.lruCounter;

      const overlapStart = Math.max(startPos, chunk.startSample);
      const overlapEnd = Math.min(startPos + available, chunk.endSample);
      if (overlapEnd <= overlapStart || activeEntries.length === 0) continue;

      const localChunkOffset = overlapStart - chunk.startSample;
      const targetFrameOffset = overlapStart - startPos;
      const count = overlapEnd - overlapStart;

      for (const entry of activeEntries) {
        const gain = entry.gain;
        if (entry.role === "instrumental") {
          if (this.stemLayout === "two_stem_direct") {
            const sL = chunk.stems.drums.left;
            const sR = chunk.stems.drums.right;
            for (let i = 0; i < count; i++) {
              const ci = localChunkOffset + i;
              const ti = (targetFrameOffset + i) * 2;
              target[ti] += sL[ci] * gain;
              target[ti + 1] += sR[ci] * gain;
            }
          } else {
            const dL = chunk.stems.drums.left;
            const dR = chunk.stems.drums.right;
            const bL = chunk.stems.bass.left;
            const bR = chunk.stems.bass.right;
            const oL = chunk.stems.other.left;
            const oR = chunk.stems.other.right;
            for (let i = 0; i < count; i++) {
              const ci = localChunkOffset + i;
              const ti = (targetFrameOffset + i) * 2;
              target[ti] += (dL[ci] + bL[ci] + oL[ci]) * gain;
              target[ti + 1] += (dR[ci] + bR[ci] + oR[ci]) * gain;
            }
          }
        } else {
          const stem = chunk.stems[entry.role];
          const sL = stem.left;
          const sR = stem.right;
          for (let i = 0; i < count; i++) {
            const ci = localChunkOffset + i;
            const ti = (targetFrameOffset + i) * 2;
            target[ti] += sL[ci] * gain;
            target[ti + 1] += sR[ci] * gain;
          }
        }
      }
    }

    return available;
  }

  dispose(): void {
    this.disposed = true;
    this.resident.clear();
    this.inFlight.clear();
    this.residentPeakAbs = 0;
  }
}
