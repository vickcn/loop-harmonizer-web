/**
 * PitchPreserveAdapter — M2C 真正保音高實作。
 *
 * 使用現有 /public/worklets/pitch-preserve-processor.js（WSOLA）：
 *   - 變速時音高維持原始音高，不隨 playbackRate 改變
 *   - tempoRatio 硬限 0.5–1.8（worklet 內部 minRatio/maxRatio）
 *
 * 已知限制（M2D/後續改善）：
 *   1. scheduleTime 被忽略 — worklet 在 async init 完成後立即播放，
 *      無法精確對齊 AudioBufferSourceNode 的 scheduleTime。
 *      多軌批次播放（playTracks）時，pitch-preserve 軌道可能比
 *      fast-rate 軌道晚 ~10-100ms 啟動（取決於首次 addModule 時間）。
 *   2. loop=false 結束偵測 — worklet 無 ended 事件，以 50ms timer
 *      監測 wall-clock 位置超過 duration 來觸發 onEnded。
 *      精度約 ±50ms，可接受。
 *   3. tempoRatio 超出 [0.5, 1.8] 時自動 clamp，不報錯。
 *
 * 接入點：MultiTrackEngine.createAdapter("pitch-preserve") 回傳此 adapter。
 */

import type { AdapterPlaybackMode, PlayOptions, TrackPlaybackAdapter } from "./types";

// Module-level cache: per AudioContext，只需 addModule 一次
const workletModuleCache = new WeakMap<AudioContext, Promise<void>>();

function ensureModule(ctx: AudioContext): Promise<void> {
  if (!workletModuleCache.has(ctx)) {
    workletModuleCache.set(
      ctx,
      ctx.audioWorklet.addModule("/worklets/pitch-preserve-processor.js")
    );
  }
  return workletModuleCache.get(ctx)!;
}

export class PitchPreserveAdapter implements TrackPlaybackAdapter {
  readonly playbackMode: AdapterPlaybackMode = "pitch-preserve";
  onEnded: (() => void) | null = null;

  private buffer: AudioBuffer | null = null;
  private gainNode: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;

  // Wall-clock position tracking（worklet 不回報位置）
  private _startWallTime = 0;   // ctx.currentTime when worklet actually started
  private _startAudioOffset = 0;
  private _pausedAt = 0;
  private _playbackRate = 1;
  private _loop = false;
  private _isPlaying = false;
  private _workletStarted = false; // true 後 getPosition 才開始計時

  // Non-loop ended detection
  private _endedTimer: ReturnType<typeof setInterval> | null = null;

  // Rate ramp (JS-side, since worklet has no AudioParam)
  private _rampTimer: ReturnType<typeof setInterval> | null = null;

  // ── TrackPlaybackAdapter ──

  load(buffer: AudioBuffer, gainNode: GainNode, ctx: AudioContext): void {
    this._stopRampTimer();
    this._teardownWorklet();
    this.buffer = buffer;
    this.gainNode = gainNode;
    this.ctx = ctx;
    this._isPlaying = false;
    this._workletStarted = false;
    this._pausedAt = 0;
    // 預先載入 worklet module（fire-and-forget），減少首次播放延遲
    void ensureModule(ctx).catch(() => { /* 失敗時 play() 會再嘗試 */ });
  }

  play(scheduleTime: number, options: PlayOptions): void {
    if (!this.buffer || !this.gainNode || !this.ctx) return;

    this._playbackRate = options.playbackRate;
    this._loop = options.loop;

    const dur = this.buffer.duration;
    const offset = dur > 0 ? ((options.offsetSec % dur) + dur) % dur : 0;
    this._pausedAt = offset;
    this._isPlaying = true;
    this._workletStarted = false;

    // scheduleTime 無法傳入 worklet；非精確同步，詳見頂部說明
    void this._asyncPlay(offset);
  }

  getPosition(ctx: AudioContext): number {
    if (!this._isPlaying || !this.buffer) return this._pausedAt;
    if (!this._workletStarted) return this._pausedAt; // 等待 async init
    const elapsed = Math.max(0, ctx.currentTime - this._startWallTime) * this._playbackRate;
    const raw = this._startAudioOffset + elapsed;
    const dur = this.buffer.duration;
    if (dur <= 0) return 0;
    if (this._loop) return ((raw % dur) + dur) % dur;
    return Math.min(raw, dur);
  }

  pause(ctx: AudioContext): void {
    if (!this._isPlaying) return;
    this._pausedAt = this.getPosition(ctx);
    this._stopRampTimer();
    this._stopEndedTimer();
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: "pause" });
      try { this.workletNode.disconnect(); } catch { /* ok */ }
    }
    this._isPlaying = false;
    this._workletStarted = false;
  }

  stop(): void {
    this._stopRampTimer();
    this._stopEndedTimer();
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: "stop" });
      try { this.workletNode.disconnect(); } catch { /* ok */ }
    }
    this._pausedAt = 0;
    this._isPlaying = false;
    this._workletStarted = false;
  }

  setPlaybackRate(rate: number, _ctx: AudioContext, rampSec = 0.5): void {
    if (this._rampTimer !== null) { clearInterval(this._rampTimer); this._rampTimer = null; }
    const fromRate = Math.max(0.5, Math.min(1.8, this._playbackRate));
    const toRate   = Math.max(0.5, Math.min(1.8, rate));
    this._playbackRate = rate;
    if (Math.abs(toRate - fromRate) < 0.001) {
      this.workletNode?.port.postMessage({ type: "setTempoRatio", ratio: toRate });
      return;
    }
    const steps = Math.max(1, Math.round(rampSec / 0.016));
    let step = 0;
    this._rampTimer = setInterval(() => {
      step++;
      const t = Math.min(step / steps, 1);
      const r = fromRate + (toRate - fromRate) * t;
      this.workletNode?.port.postMessage({ type: "setTempoRatio", ratio: r });
      if (t >= 1) { clearInterval(this._rampTimer!); this._rampTimer = null; }
    }, Math.round(rampSec / steps * 1000));
  }

  setLoop(loop: boolean, onEnded: (() => void) | null): void {
    const wasLoop = this._loop;
    this._loop = loop;
    this.onEnded = onEnded;
    if (this._isPlaying && this._workletStarted) {
      if (!loop && wasLoop) this._startEndedTimer();
      else if (loop && !wasLoop) this._stopEndedTimer();
    }
  }

  dispose(): void {
    this._stopRampTimer();
    this._stopEndedTimer();
    this._teardownWorklet();
    this.buffer = null;
    this.gainNode = null;
    this.ctx = null;
  }

  // ── private ──

  private async _asyncPlay(offsetSec: number): Promise<void> {
    if (!this.ctx || !this.buffer || !this.gainNode) return;

    try {
      await this._ensureWorkletNode();
    } catch (e) {
      console.warn("[PitchPreserveAdapter] worklet init failed, giving up:", e);
      this._isPlaying = false;
      return;
    }

    // Guard: 若在 async 等待期間被 stop/pause/dispose，則放棄
    if (!this._isPlaying || !this.workletNode || !this.gainNode) return;

    this.workletNode.connect(this.gainNode);
    this.workletNode.port.postMessage({ type: "setPosition", seconds: offsetSec, sampleRate: this.buffer.sampleRate });
    this.workletNode.port.postMessage({ type: "play" });
    this.workletNode.port.postMessage({ type: "setTempoRatio", ratio: Math.max(0.5, Math.min(1.8, this._playbackRate)) });

    // 從 worklet 真正開始播放後才計時
    this._startWallTime = this.ctx.currentTime;
    this._startAudioOffset = offsetSec;
    this._workletStarted = true;

    if (!this._loop) this._startEndedTimer();
  }

  private async _ensureWorkletNode(): Promise<void> {
    if (this.workletNode) return;
    if (!this.ctx || !this.buffer) return;

    await ensureModule(this.ctx);

    // 再次確認尚未被 dispose
    if (!this.ctx || !this.buffer) return;

    const channelCount = Math.min(2, Math.max(1, this.buffer.numberOfChannels));
    const node = new AudioWorkletNode(this.ctx, "pitch-preserve-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channelCount],
    });

    // .slice() 複製 channel data；保留原 AudioBuffer 可重複使用
    const channels = Array.from({ length: channelCount }, (_, i) =>
      this.buffer!.getChannelData(i).slice()
    );
    node.port.postMessage({ type: "load", channels }, channels.map((c) => c.buffer));
    node.port.postMessage({ type: "setGain", gain: 0.95 });
    this.workletNode = node;
  }

  private _teardownWorklet(): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ type: "stop" });
    try { this.workletNode.disconnect(); } catch { /* ok */ }
    this.workletNode = null;
    this._isPlaying = false;
    this._workletStarted = false;
  }

  private _startEndedTimer(): void {
    this._stopEndedTimer();
    if (!this.buffer) return;
    const dur = this.buffer.duration;
    this._endedTimer = setInterval(() => {
      if (!this._isPlaying || !this.ctx || !this._workletStarted) return;
      const pos = this.getPosition(this.ctx);
      if (pos >= dur - 0.08) {
        this._stopEndedTimer();
        this.workletNode?.port.postMessage({ type: "stop" });
        try { this.workletNode?.disconnect(); } catch { /* ok */ }
        this._isPlaying = false;
        this._workletStarted = false;
        this._pausedAt = 0;
        this.onEnded?.();
      }
    }, 50);
  }

  private _stopEndedTimer(): void {
    if (this._endedTimer !== null) {
      clearInterval(this._endedTimer);
      this._endedTimer = null;
    }
  }

  private _stopRampTimer(): void {
    if (this._rampTimer !== null) {
      clearInterval(this._rampTimer);
      this._rampTimer = null;
    }
  }
}
