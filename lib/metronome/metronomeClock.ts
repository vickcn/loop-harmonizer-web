import {
  BUILT_IN_SOUNDS,
  DEFAULT_SOUND_ID,
  MetronomeSound,
} from "./metronomeSound";

const LOOKAHEAD_SECS = 0.15;
const SCHEDULE_INTERVAL_MS = 25;

export class MetronomeClock {
  private ctx: AudioContext;
  private gainNode: GainNode;
  private getBpmAt: (audioTime: number) => number;

  private beatsPerBar = 4;
  private enabled = false;
  private accentFirstBeat = true;
  private sound: MetronomeSound =
    BUILT_IN_SOUNDS.find((s) => s.id === DEFAULT_SOUND_ID)!;

  private nextBeatTime = 0;
  private beatInBar = 0;
  private isRunning = false;
  private timerId: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: AudioContext, getBpmAt: (audioTime: number) => number) {
    this.ctx = ctx;
    this.getBpmAt = getBpmAt;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0.8;
    this.gainNode.connect(ctx.destination);
  }

  setEnabled(v: boolean) { this.enabled = v; }
  setVolume(v: number) { this.gainNode.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.02); }
  setAccentFirstBeat(v: boolean) { this.accentFirstBeat = v; }
  setBeatsPerBar(v: number) { this.beatsPerBar = v; }
  setSound(sound: MetronomeSound) { this.sound = sound; }

  // pausedSeconds and baseBpm are used to align beat phase when resuming mid-loop
  start(
    ctxNow: number,
    pausedSeconds: number,
    baseBpm: number,
    beatsPerBar: number,
    immediateFirstBeat = false
  ) {
    this.stop();
    this.beatsPerBar = beatsPerBar;

    if (immediateFirstBeat) {
      this.beatInBar = 0;
      this.nextBeatTime = ctxNow + 0.02;
      this.isRunning = true;
      this.loop();
      return;
    }

    const totalBeats = (pausedSeconds * baseBpm) / 60;
    const currentBeatIndex = Math.floor(totalBeats);
    const beatFraction = totalBeats - currentBeatIndex;
    const bpmNow = this.getBpmAt(ctxNow);
    const secsToNextBeat = (1 - beatFraction) * (60 / Math.max(1, bpmNow));

    this.beatInBar = (currentBeatIndex + 1) % this.beatsPerBar;
    this.nextBeatTime = ctxNow + secsToNextBeat;
    this.isRunning = true;
    this.loop();
  }

  pause() {
    this.isRunning = false;
    if (this.timerId) { clearTimeout(this.timerId); this.timerId = null; }
  }

  stop() {
    this.isRunning = false;
    if (this.timerId) { clearTimeout(this.timerId); this.timerId = null; }
    this.beatInBar = 0;
  }

  private loop() {
    while (this.nextBeatTime < this.ctx.currentTime + LOOKAHEAD_SECS) {
      if (this.enabled) this.click(this.nextBeatTime, this.beatInBar === 0);
      const bpm = this.getBpmAt(this.nextBeatTime);
      this.nextBeatTime += 60 / Math.max(1, bpm);
      this.beatInBar = (this.beatInBar + 1) % this.beatsPerBar;
    }
    if (this.isRunning) {
      this.timerId = setTimeout(() => this.loop(), SCHEDULE_INTERVAL_MS);
    }
  }

  private click(time: number, isAccent: boolean) {
    const {
      wave, accentFreq, beatFreq, accentPeak, beatPeak, attack, decay, duration,
    } = this.sound;

    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.connect(env);
    env.connect(this.gainNode);

    osc.type = wave as OscillatorType;
    osc.frequency.value = isAccent && this.accentFirstBeat ? accentFreq : beatFreq;
    const peak = isAccent && this.accentFirstBeat ? accentPeak : beatPeak;

    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + attack);
    env.gain.exponentialRampToValueAtTime(0.001, time + attack + decay);
    osc.start(time);
    osc.stop(time + duration);
  }
}
