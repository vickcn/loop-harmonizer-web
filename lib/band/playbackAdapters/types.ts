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

export type AdapterPlaybackMode = "fast-rate" | "pitch-preserve";

export interface PlayOptions {
  offsetSec: number;
  playbackRate: number;
  loop: boolean;
}

export interface TrackPlaybackAdapter {
  readonly playbackMode: AdapterPlaybackMode;

  /**
   * 將 AudioBuffer 連接到 gainNode，準備播放。
   * 每次 loadTrack 後呼叫一次；換 buffer 時重新呼叫。
   */
  load(buffer: AudioBuffer, gainNode: GainNode, ctx: AudioContext): void;

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

  /** 即時切換 loop；播放中生效。 */
  setLoop(loop: boolean, onEnded: (() => void) | null): void;

  /** 釋放所有資源。 */
  dispose(): void;

  /** 播完（非 loop）時呼叫的 callback；由 engine 設定。 */
  onEnded: (() => void) | null;
}
