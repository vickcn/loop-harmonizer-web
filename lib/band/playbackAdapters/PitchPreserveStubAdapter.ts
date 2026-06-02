/**
 * PitchPreserveStubAdapter — M2B 佔位。
 *
 * ⚠ 目前「保音高」功能尚未實作：
 *   此 adapter 內部委派給 FastRateAdapter，音高仍會隨速率改變。
 *
 * M2C 計畫：
 *   以 AudioWorkletProcessor（WSOLA 或相位聲碼）取代內部的 FastRateAdapter 委派。
 *   屆時介面（load / play / pause / stop / seek 等）完全不變，
 *   MultiTrackEngine 不需修改，只需換掉此檔的實作。
 *
 * 目前音訊行為 = FastRateAdapter（完整 M1 行為）。
 */

import { FastRateAdapter } from "./FastRateAdapter";
import type { AdapterPlaybackMode, PlayOptions, TrackPlaybackAdapter } from "./types";

export class PitchPreserveStubAdapter implements TrackPlaybackAdapter {
  readonly playbackMode: AdapterPlaybackMode = "pitch-preserve";

  // M2C: 換成真正 AudioWorklet 實作時，移除此行並實作每個方法
  private inner = new FastRateAdapter();

  get onEnded(): (() => void) | null { return this.inner.onEnded; }
  set onEnded(cb: (() => void) | null) { this.inner.onEnded = cb; }

  load(buffer: AudioBuffer, gainNode: GainNode, ctx: AudioContext): void {
    // M2C: 初始化 AudioWorkletNode，不再委派給 FastRateAdapter
    this.inner.load(buffer, gainNode, ctx);
  }

  play(scheduleTime: number, options: PlayOptions): void {
    // M2C: 送 message 給 AudioWorkletProcessor，傳入 offsetSec 與 playbackRate
    this.inner.play(scheduleTime, options);
  }

  getPosition(ctx: AudioContext): number {
    // M2C: 從 AudioWorkletNode port 讀取 currentSample / sampleRate
    return this.inner.getPosition(ctx);
  }

  pause(ctx: AudioContext): void {
    // M2C: postMessage({ type: "pause" }) 給 worklet
    this.inner.pause(ctx);
  }

  stop(): void {
    // M2C: postMessage({ type: "stop" }) 給 worklet，釋放資源
    this.inner.stop();
  }

  setPlaybackRate(rate: number, ctx: AudioContext): void {
    // M2C: postMessage({ type: "setRate", rate }) 給 worklet
    this.inner.setPlaybackRate(rate, ctx);
  }

  setLoop(loop: boolean, onEnded: (() => void) | null): void {
    // M2C: postMessage({ type: "setLoop", loop }) 給 worklet
    this.inner.setLoop(loop, onEnded);
  }

  dispose(): void {
    // M2C: worklet.port.close()；AudioWorkletNode.disconnect()
    this.inner.dispose();
  }
}
