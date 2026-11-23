/**
 * M2B: TrackPlaybackAdapter 介面
 *
 * 每個 adapter 封裝單一播放模式的音訊生命週期。
 * MultiTrackEngine 不再直接操作 AudioBufferSourceNode，
 * 改為透過此介面與各 adapter 溝通。
 *
 * 已實作：
 *   FastRateAdapter      — AudioBufferSourceNode.playbackRate（M1 行為）
 *
 * 佔位（M2C 實作真正演算法）：
 *   PitchPreservePlaceholderAdapter — 目前 fallback 到 FastRateAdapter
 */

export type AdapterPlaybackMode = "fast-rate" | "pitch-preserve" | "soundtouch";

export interface PlayOptions {
  offsetSec: number;
  playbackRate: number;
  loop: boolean;
  /**
   * 可選的絕對時間循環範圍。省略時維持整首循環；僅在 loop=true 時生效。
   * Adapter 仍以原始音訊時間軸回報播放位置。
   */
  loopStartSec?: number;
  loopEndSec?: number;
}

export type PlaybackLoopRange = {
  startSec: number;
  endSec: number;
};

export interface TrackPlaybackAdapter {
  readonly playbackMode: AdapterPlaybackMode;

  /**
   * 將 AudioBuffer 連接到 gainNode，準備播放。
   * 每次 loadTrack 後呼叫一次；換 buffer 時重新呼叫。
   */
  load(buffer: AudioBuffer, gainNode: GainNode, ctx: AudioContext): void;

  /** 可選的延遲模組預載；群組播放會先等所有 adapter 就緒再於同一 tick 啟動。 */
  prepare?(): Promise<void>;

  /**
   * 從 offsetSec 開始，在 scheduleTime（AudioContext 時間）播放。
   * 呼叫前必須先呼叫 load()。
   */
  play(scheduleTime: number, options: PlayOptions): void;

  /** 取得目前播放位置（秒）；若未播放回傳 pausedAt。 */
  getPosition(ctx: AudioContext): number;

  /** 暫停：記錄目前位置，停止聲源。 */
  pause(ctx: AudioContext): void;

  /** 停止並歸零位置。 */
  stop(): void;

  /** 設定播放速率；rampSec 內線性漸變（預設 0.5 秒）。 */
  setPlaybackRate(rate: number, ctx: AudioContext, rampSec?: number): void;

  /** 設定升降 Key 半音數；不支援的 adapter 維持原音高。 */
  setPitchSemitones(semitones: number, ctx: AudioContext): void;

  /** 即時切換 loop 與其範圍；播放中生效。 */
  setLoop(
    loop: boolean,
    onEnded: (() => void) | null,
    loopRange?: PlaybackLoopRange | null,
  ): void;

  /** 釋放所有資源。 */
  dispose(): void;

  /** 播完（非 loop）時呼叫的 callback；由 engine 設定。 */
  onEnded: (() => void) | null;
}
