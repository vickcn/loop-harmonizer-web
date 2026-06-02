type InternalTrack = {
  buffer: AudioBuffer;
  gainNode: GainNode;
  source: AudioBufferSourceNode | null;
  startCtxTime: number;
  startAudioOffset: number;
  pausedAt: number;
  isPlaying: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
};

export class MultiTrackEngine {
  private ctx: AudioContext | null = null;
  private tracks = new Map<string, InternalTrack>();

  private ensureCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  private stopSource(t: InternalTrack): void {
    if (!t.source) return;
    try { t.source.stop(); } catch { /* already stopped */ }
    try { t.source.disconnect(); } catch { /* already disconnected */ }
    t.source = null;
  }

  private startAt(t: InternalTrack, scheduleTime: number): void {
    this.stopSource(t);
    const dur = t.buffer.duration;
    const audioOffset = dur > 0 ? ((t.pausedAt % dur) + dur) % dur : 0;
    const src = this.ctx!.createBufferSource();
    src.buffer = t.buffer;
    src.loop = true;
    src.playbackRate.value = t.playbackRate;
    src.connect(t.gainNode);
    src.start(scheduleTime, audioOffset);
    t.source = src;
    t.startCtxTime = scheduleTime;
    t.startAudioOffset = audioOffset;
    t.isPlaying = true;
  }

  async loadTrack(trackId: string, file: File): Promise<number> {
    const ctx = this.ensureCtx();
    const ab = await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(ab);

    const existing = this.tracks.get(trackId);
    if (existing) {
      this.stopSource(existing);
      try { existing.gainNode.disconnect(); } catch { /* ok */ }
    }

    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    gainNode.connect(ctx.destination);

    this.tracks.set(trackId, {
      buffer,
      gainNode,
      source: null,
      startCtxTime: 0,
      startAudioOffset: 0,
      pausedAt: 0,
      isPlaying: false,
      playbackRate: 1,
      volume: 1,
      muted: false,
    });

    return buffer.duration;
  }

  async playTrack(trackId: string): Promise<void> {
    const ctx = this.ensureCtx();
    await ctx.resume();
    const t = this.tracks.get(trackId);
    if (!t) return;
    this.startAt(t, ctx.currentTime + 0.01);
  }

  pauseTrack(trackId: string): void {
    const t = this.tracks.get(trackId);
    if (!t || !t.isPlaying) return;
    t.pausedAt = this.getTrackPosition(trackId);
    this.stopSource(t);
    t.isPlaying = false;
  }

  stopTrack(trackId: string): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    this.stopSource(t);
    t.pausedAt = 0;
    t.isPlaying = false;
  }

  async seekTrack(trackId: string, sec: number): Promise<void> {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.pausedAt = Math.max(0, sec);
    if (t.isPlaying) {
      const ctx = this.ensureCtx();
      this.startAt(t, ctx.currentTime + 0.01);
    }
  }

  async playTracks(trackIds: string[]): Promise<void> {
    const ctx = this.ensureCtx();
    await ctx.resume();
    const scheduleTime = ctx.currentTime + 0.02;
    for (const id of trackIds) {
      const t = this.tracks.get(id);
      if (!t) continue;
      this.startAt(t, scheduleTime);
    }
  }

  pauseTracks(trackIds: string[]): void {
    for (const id of trackIds) this.pauseTrack(id);
  }

  stopTracks(trackIds: string[]): void {
    for (const id of trackIds) this.stopTrack(id);
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

  setPlaybackRate(trackId: string, rate: number): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    t.playbackRate = Math.max(0.1, Math.min(4, rate));
    if (t.source && this.ctx) {
      t.source.playbackRate.setTargetAtTime(t.playbackRate, this.ctx.currentTime, 0.05);
    }
  }

  getTrackPosition(trackId: string): number {
    const t = this.tracks.get(trackId);
    if (!t) return 0;
    if (!t.isPlaying || !this.ctx) return t.pausedAt;
    const elapsed = Math.max(0, this.ctx.currentTime - t.startCtxTime) * t.playbackRate;
    const raw = t.startAudioOffset + elapsed;
    const dur = t.buffer.duration;
    if (dur <= 0) return 0;
    return ((raw % dur) + dur) % dur;
  }

  dispose(): void {
    for (const t of this.tracks.values()) {
      this.stopSource(t);
      try { t.gainNode.disconnect(); } catch { /* ok */ }
    }
    this.tracks.clear();
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.close();
    }
    this.ctx = null;
  }
}
