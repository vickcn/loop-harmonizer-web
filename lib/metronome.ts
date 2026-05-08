const LOOKAHEAD_SECS = 0.15;
const SCHEDULE_INTERVAL_MS = 25;

export class Metronome {
  private ctx: AudioContext;
  private gainNode: GainNode;
  private getBpmAt: (audioTime: number) => number;

  private beatsPerBar = 4;
  private enabled = false;
  private accentFirstBeat = true;

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

  start(audioCtxNow: number, pausedSeconds: number, originalBpm: number, beatsPerBar: number) {
    this.stop();
    this.beatsPerBar = beatsPerBar;

    const totalBeats = (pausedSeconds * originalBpm) / 60;
    const currentBeatIndex = Math.floor(totalBeats);
    const beatFraction = totalBeats - currentBeatIndex;
    const bpmNow = this.getBpmAt(audioCtxNow);
    const secsToNextBeat = (1 - beatFraction) * (60 / Math.max(1, bpmNow));

    this.beatInBar = (currentBeatIndex + 1) % this.beatsPerBar;
    this.nextBeatTime = audioCtxNow + secsToNextBeat;
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
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.connect(env);
    env.connect(this.gainNode);
    osc.type = "sine";
    osc.frequency.value = isAccent && this.accentFirstBeat ? 1200 : 900;
    const peak = isAccent && this.accentFirstBeat ? 1.0 : 0.6;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    osc.start(time);
    osc.stop(time + 0.05);
  }
}
