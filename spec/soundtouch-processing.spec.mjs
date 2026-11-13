import assert from "node:assert/strict";
import test from "node:test";

let SoundTouch;
let SimpleFilter;
let WebAudioBufferSource;

try {
  ({ SoundTouch, SimpleFilter, WebAudioBufferSource } = await import("../public/vendor/soundtouch.js"));
} catch {
  // The assertions below intentionally fail until the SoundTouch runtime is migrated.
}

const SAMPLE_RATE = 44100;
const INPUT_SECONDS = 4;
const TONE_HZ = 440;

function renderTone(tempo, pitchSemitones) {
  const input = new Float32Array(SAMPLE_RATE * INPUT_SECONDS);
  for (let index = 0; index < input.length; index += 1) {
    input[index] = Math.sin(2 * Math.PI * TONE_HZ * index / SAMPLE_RATE);
  }
  const buffer = {
    numberOfChannels: 1,
    getChannelData: () => input,
  };
  const soundTouch = new SoundTouch();
  soundTouch.tempo = tempo;
  soundTouch.pitchSemitones = pitchSemitones;
  const filter = new SimpleFilter(new WebAudioBufferSource(buffer), soundTouch);
  const chunk = new Float32Array(4096 * 2);
  const output = [];
  let emptyReads = 0;

  for (let block = 0; block < 1000 && emptyReads < 3; block += 1) {
    const frames = filter.extract(chunk, 4096);
    if (frames === 0) {
      emptyReads += 1;
      continue;
    }
    emptyReads = 0;
    for (let index = 0; index < frames; index += 1) output.push(chunk[index * 2]);
  }

  const start = Math.floor(SAMPLE_RATE * 0.4);
  const end = Math.min(output.length, start + Math.floor(SAMPLE_RATE * 1.5));
  let crossings = 0;
  for (let index = start + 1; index < end; index += 1) {
    if (output[index - 1] <= 0 && output[index] > 0) crossings += 1;
  }

  return {
    frameCount: output.length,
    frequencyHz: crossings / ((end - start) / SAMPLE_RATE),
  };
}

const cases = [
  { tempo: 1, semitones: 0 },
  { tempo: 1.25, semitones: 0 },
  { tempo: 1, semitones: 3 },
  { tempo: 0.8, semitones: -2 },
  { tempo: 1.25, semitones: 5 },
];

test("SoundTouch applies requested tempo and semitone changes to rendered audio", () => {
  const baseline = renderTone(1, 0);

  for (const { tempo, semitones } of cases) {
    const rendered = renderTone(tempo, semitones);
    const expectedFrameRatio = 1 / tempo;
    const actualFrameRatio = rendered.frameCount / baseline.frameCount;
    const expectedFrequency = TONE_HZ * 2 ** (semitones / 12);

    assert.ok(
      Math.abs(actualFrameRatio - expectedFrameRatio) < 0.05,
      `${tempo}× should produce ${expectedFrameRatio.toFixed(3)} output duration ratio, got ${actualFrameRatio.toFixed(3)}`,
    );
    assert.ok(
      Math.abs(rendered.frequencyHz - expectedFrequency) / expectedFrequency < 0.03,
      `${semitones} semitones should produce ${expectedFrequency.toFixed(1)} Hz, got ${rendered.frequencyHz.toFixed(1)} Hz`,
    );
  }
});
