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
    this.readPos = 0;
    this.outputCounter = 0;
    this.nextGrainAt = 0;
    this.grains = [];
    this.grainSize = 2048;
    this.hopOut = 512;
    this.maxGrains = 12;

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'load') {
        this.channels = msg.channels || [];
        this.channelCount = this.channels.length;
        this.length = this.channelCount > 0 ? this.channels[0].length : 0;
        this.loaded = this.length > 0;
        this.readPos = 0;
        this.outputCounter = 0;
        this.nextGrainAt = 0;
        this.grains = [];
      }
      if (msg.type === 'play') this.isPlaying = true;
      if (msg.type === 'pause') this.isPlaying = false;
      if (msg.type === 'stop') {
        this.isPlaying = false;
        this.readPos = 0;
        this.outputCounter = 0;
        this.nextGrainAt = 0;
        this.grains = [];
      }
      if (msg.type === 'setTempoRatio') {
        const ratio = Number(msg.ratio);
        if (Number.isFinite(ratio) && ratio > 0) {
          this.targetTempoRatio = Math.max(0.35, Math.min(2.5, ratio));
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

  windowAt(age) {
    if (age < 0 || age >= this.grainSize) return 0;
    return 0.5 - 0.5 * Math.cos((2 * Math.PI * age) / (this.grainSize - 1));
  }

  maybeSpawnGrain() {
    while (this.outputCounter >= this.nextGrainAt) {
      this.grains.push({ inputPos: this.wrap(this.readPos), age: 0 });
      if (this.grains.length > this.maxGrains) this.grains.shift();
      this.readPos = this.wrap(this.readPos + this.hopOut * this.tempoRatio);
      this.nextGrainAt += this.hopOut;
    }
  }

  process(_, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const frames = output[0].length;
    for (let c = 0; c < output.length; c++) output[c].fill(0);

    if (!this.loaded || !this.isPlaying) return true;

    for (let i = 0; i < frames; i++) {
      this.tempoRatio += (this.targetTempoRatio - this.tempoRatio) * 0.0025;
      this.maybeSpawnGrain();

      for (let c = 0; c < output.length; c++) {
        const srcChannel = Math.min(c, this.channelCount - 1);
        let sum = 0;
        let weight = 0;
        for (let g = 0; g < this.grains.length; g++) {
          const grain = this.grains[g];
          const w = this.windowAt(grain.age);
          if (w > 0) {
            sum += this.sampleAt(srcChannel, grain.inputPos + grain.age) * w;
            weight += w;
          }
        }
        output[c][i] = weight > 0 ? (sum / weight) * this.gain : 0;
      }

      for (let g = this.grains.length - 1; g >= 0; g--) {
        this.grains[g].age += 1;
        if (this.grains[g].age >= this.grainSize) this.grains.splice(g, 1);
      }
      this.outputCounter += 1;
    }

    return true;
  }
}

registerProcessor('pitch-preserve-processor', PitchPreserveProcessor);
