class PitchPreserveProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = [];
    this.channelCount = 0;
    this.length = 0;
    this.loaded = false;
    this.isPlaying = false;
    this.tempoRatio = 1;
    this.targetTempoRatio = 1;
    this.gain = 1;

    this.inputPos = 0;
    this.frame = null;
    this.prevTail = null;
    this.framePos = 0;

    this.frameSize = 2048;
    this.overlap = 512;
    this.synthesisHop = this.frameSize - this.overlap;
    this.searchRadius = 384;
    this.searchStep = 8;
    this.minRatio = 0.5;
    this.maxRatio = 1.8;

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'load') {
        this.channels = msg.channels || [];
        this.channelCount = this.channels.length;
        this.length = this.channelCount > 0 ? this.channels[0].length : 0;
        this.loaded = this.length > 0;
        this.inputPos = 0;
        this.frame = null;
        this.prevTail = null;
        this.framePos = 0;
      }
      if (msg.type === 'play') this.isPlaying = true;
      if (msg.type === 'pause') this.isPlaying = false;
      if (msg.type === 'stop') {
        this.isPlaying = false;
        this.inputPos = 0;
        this.frame = null;
        this.prevTail = null;
        this.framePos = 0;
      }
      if (msg.type === 'setTempoRatio') {
        const ratio = Number(msg.ratio);
        if (Number.isFinite(ratio) && ratio > 0) {
          this.targetTempoRatio = Math.max(this.minRatio, Math.min(this.maxRatio, ratio));
        }
      }
      if (msg.type === 'setPosition') {
        const seconds = Number(msg.seconds);
        const sampleRate = Number(msg.sampleRate);
        if (Number.isFinite(seconds) && Number.isFinite(sampleRate) && sampleRate > 0) {
          this.inputPos = this.wrap(seconds * sampleRate);
          this.frame = null;
          this.prevTail = null;
          this.framePos = 0;
        }
      }
      if (msg.type === 'setGain') {
        const gain = Number(msg.gain);
        if (Number.isFinite(gain)) this.gain = Math.max(0, Math.min(1.5, gain));
      }
    };
  }

  wrap(pos) {
    if (!this.length) return 0;
    let next = pos % this.length;
    if (next < 0) next += this.length;
    return next;
  }

  sampleAt(channel, pos) {
    if (!this.loaded || !this.channels[channel]) return 0;
    const wrapped = this.wrap(pos);
    const i0 = Math.floor(wrapped);
    const i1 = (i0 + 1) % this.length;
    const frac = wrapped - i0;
    const data = this.channels[channel];
    return data[i0] * (1 - frac) + data[i1] * frac;
  }

  fadeIn(i, n) {
    return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, i / Math.max(1, n - 1))));
  }

  fadeOut(i, n) {
    return 1 - this.fadeIn(i, n);
  }

  allocateFrame() {
    const frame = [];
    for (let c = 0; c < Math.max(1, this.channelCount); c++) {
      frame.push(new Float32Array(this.frameSize));
    }
    return frame;
  }

  allocateTail() {
    const tail = [];
    for (let c = 0; c < Math.max(1, this.channelCount); c++) {
      tail.push(new Float32Array(this.overlap));
    }
    return tail;
  }

  correlationAt(candidatePos) {
    if (!this.prevTail) return 0;
    let dot = 0;
    let energyA = 0;
    let energyB = 0;
    const channelsToCheck = Math.min(2, Math.max(1, this.channelCount));
    for (let c = 0; c < channelsToCheck; c++) {
      const tail = this.prevTail[c] || this.prevTail[0];
      for (let i = 0; i < this.overlap; i += 4) {
        const a = tail[i];
        const b = this.sampleAt(c, candidatePos + i);
        dot += a * b;
        energyA += a * a;
        energyB += b * b;
      }
    }
    const denom = Math.sqrt(energyA * energyB) + 1e-9;
    return dot / denom;
  }

  findBestInputPos(expectedPos) {
    if (!this.prevTail) return this.wrap(expectedPos);
    let bestPos = expectedPos;
    let bestScore = -Infinity;
    for (let offset = -this.searchRadius; offset <= this.searchRadius; offset += this.searchStep) {
      const candidate = this.wrap(expectedPos + offset);
      const score = this.correlationAt(candidate);
      if (score > bestScore) {
        bestScore = score;
        bestPos = candidate;
      }
    }
    return this.wrap(bestPos);
  }

  buildNextFrame() {
    this.tempoRatio += (this.targetTempoRatio - this.tempoRatio) * 0.15;
    const analysisHop = this.synthesisHop * this.tempoRatio;
    const expectedPos = this.inputPos;
    const bestPos = this.findBestInputPos(expectedPos);
    const nextFrame = this.allocateFrame();

    for (let c = 0; c < nextFrame.length; c++) {
      for (let i = 0; i < this.frameSize; i++) {
        nextFrame[c][i] = this.sampleAt(c, bestPos + i);
      }
    }

    if (this.prevTail) {
      for (let c = 0; c < nextFrame.length; c++) {
        const tail = this.prevTail[c] || this.prevTail[0];
        for (let i = 0; i < this.overlap; i++) {
          const a = tail[i] * this.fadeOut(i, this.overlap);
          const b = nextFrame[c][i] * this.fadeIn(i, this.overlap);
          nextFrame[c][i] = a + b;
        }
      }
    }

    const newTail = this.allocateTail();
    const tailStart = this.synthesisHop;
    for (let c = 0; c < newTail.length; c++) {
      for (let i = 0; i < this.overlap; i++) {
        newTail[c][i] = nextFrame[c][tailStart + i] || 0;
      }
    }
    this.prevTail = newTail;
    this.frame = nextFrame;
    this.framePos = 0;
    this.inputPos = this.wrap(expectedPos + analysisHop);
  }

  process(_, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    for (let c = 0; c < output.length; c++) output[c].fill(0);
    if (!this.loaded || !this.isPlaying) return true;

    for (let i = 0; i < frames; i++) {
      if (!this.frame || this.framePos >= this.synthesisHop) this.buildNextFrame();
      for (let c = 0; c < output.length; c++) {
        const srcChannel = Math.min(c, this.frame.length - 1);
        output[c][i] = (this.frame[srcChannel][this.framePos] || 0) * this.gain;
      }
      this.framePos += 1;
    }
    return true;
  }
}

registerProcessor('pitch-preserve-processor', PitchPreserveProcessor);
