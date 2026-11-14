import assert from "node:assert/strict";
import test from "node:test";
import { DemucsProcessor } from "../public/vendor/demucs-web/processor.js";
import { CONSTANTS } from "../public/vendor/demucs-web/constants.js";

let buildSeparatedStemSet;
let deriveTwoStemFromFourStemSet;
let encodeStereoWav;
let createStemTrackDescriptors;
let createAudioBufferFromStem;

try {
  ({ buildSeparatedStemSet, deriveTwoStemFromFourStemSet } = await import("../lib/separation/stemTypes.ts"));
  ({ createStemTrackDescriptors } = await import("../lib/separation/stemTypes.ts"));
  ({ encodeStereoWav } = await import("../lib/separation/wavEncoder.ts"));
  ({ createAudioBufferFromStem } = await import("../lib/separation/audioBuffer.ts"));
} catch {
  // The assertions below intentionally fail until the separation modules exist.
}

const fourStemResult = {
  vocals: { left: new Float32Array([0.1, 0.2]), right: new Float32Array([0.3, 0.4]) },
  drums: { left: new Float32Array([0.2, 0.1]), right: new Float32Array([0.4, 0.3]) },
  bass: { left: new Float32Array([0.3, 0.2]), right: new Float32Array([0.5, 0.4]) },
  other: { left: new Float32Array([0.4, 0.3]), right: new Float32Array([0.6, 0.5]) },
};

function assertSamplesClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((sample, index) => {
    assert.ok(Math.abs(sample - expected[index]) < 0.000001, `sample ${index} differs`);
  });
}

test("two-stem result preserves vocals and sums the other three stems", () => {
  const result = buildSeparatedStemSet(fourStemResult, 44100, "two_stem");

  assert.deepEqual(result.tracks.map((track) => track.stemType), ["vocals", "instrumental"]);
  assertSamplesClose(result.tracks[0].left, [0.1, 0.2]);
  assertSamplesClose(result.tracks[1].left, [0.9, 0.6]);
  assertSamplesClose(result.tracks[1].right, [1.5, 1.2]);
});

test("four-stem result keeps the expected track order", () => {
  const result = buildSeparatedStemSet(fourStemResult, 44100, "four_stem");

  assert.deepEqual(result.tracks.map((track) => track.stemType), ["vocals", "drums", "bass", "other"]);
  assert.equal(result.sampleRate, 44100);
});

test("WAV encoder outputs a 16-bit stereo RIFF payload", () => {
  const blob = encodeStereoWav(new Float32Array([-1, 1]), new Float32Array([0, 0.5]), 44100);
  const view = new DataView(blob);

  assert.equal(new TextDecoder().decode(new Uint8Array(blob, 0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(new Uint8Array(blob, 8, 4)), "WAVE");
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 0);
});

test("stem track descriptors share a source group and default to sync-safe playback", () => {
  const stems = buildSeparatedStemSet(fourStemResult, 44100, "two_stem");
  const tracks = createStemTrackDescriptors(stems, "full-song.mp3", "group_demo", (stemType) => `track_${stemType}`);

  assert.deepEqual(tracks.map((track) => track.id), ["track_vocals", "track_instrumental"]);
  assert.deepEqual(tracks.map((track) => track.stemMetadata?.sourceGroupId), ["group_demo", "group_demo"]);
  assert.deepEqual(tracks.map((track) => track.playbackMode), ["soundtouch", "soundtouch"]);
  assert.deepEqual(tracks.map((track) => track.syncMode), ["global-bpm", "global-bpm"]);
  assert.deepEqual(tracks.map((track) => track.followsGlobalKey), [true, true]);
  assert.deepEqual(tracks.map((track) => track.selected), [true, true]);
  assert.equal(tracks[0].durationSec, 2 / 44100);
});

test("PCM stem data becomes a stereo AudioBuffer without a WAV round-trip", () => {
  const copiedChannels = [];
  const context = {
    createBuffer(numberOfChannels, length, sampleRate) {
      return {
        numberOfChannels,
        length,
        sampleRate,
        getChannelData(index) {
          return {
            set(channel) {
              copiedChannels[index] = [...channel];
            },
          };
        },
      };
    },
  };

  const buffer = createAudioBufferFromStem(context, {
    stemType: "vocals",
    left: new Float32Array([0.1, 0.2]),
    right: new Float32Array([0.3, 0.4]),
  }, 44100);

  assert.equal(buffer.numberOfChannels, 2);
  assert.equal(buffer.length, 2);
  assert.equal(buffer.sampleRate, 44100);
  assertSamplesClose(copiedChannels[0], [0.1, 0.2]);
  assertSamplesClose(copiedChannels[1], [0.3, 0.4]);
});

test("derives two-stem set directly from an existing four-stem set without rerunning separation", () => {
  const fourStem = buildSeparatedStemSet(fourStemResult, 44100, "four_stem");
  const twoStem = deriveTwoStemFromFourStemSet(fourStem);

  assert.ok(twoStem);
  assert.equal(twoStem.mode, "two_stem");
  assert.deepEqual(twoStem.tracks.map((track) => track.stemType), ["vocals", "instrumental"]);
  assertSamplesClose(twoStem.tracks[0].left, [0.1, 0.2]);
  assertSamplesClose(twoStem.tracks[1].left, [0.9, 0.6]);
  assertSamplesClose(twoStem.tracks[1].right, [1.5, 1.2]);
  assert.equal(deriveTwoStemFromFourStemSet(twoStem), null);
});

test("DemucsProcessor two_stem mode accumulates instrumental per segment using only 2 full-song output buffers", async () => {
  const samples = CONSTANTS.TRAINING_SAMPLES;
  const mockOrt = {
    Tensor: class {
      constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
      dispose() {}
    },
    InferenceSession: {
      create: async () => ({
        inputNames: ["input", "spec"],
        outputNames: ["time_out"],
        release: async () => {},
        run: async () => {
          const timeData = new Float32Array(1 * 4 * 2 * samples);
          for (let t = 0; t < 4; t++) {
            const val = (t + 1) * 0.1; // drums=0.1, bass=0.2, other=0.3, vocals=0.4
            for (let c = 0; c < 2; c++) {
              const offset = t * 2 * samples + c * samples;
              timeData.fill(val, offset, offset + samples);
            }
          }
          return {
            time_out: {
              dims: [1, 4, 2, samples],
              data: timeData,
              dispose() {},
            },
          };
        },
      }),
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });

  try {
    const proc = new DemucsProcessor({ ort: mockOrt });
    await proc.loadModel("blob:mock-model");

    const len = 320000; // > stride (257985) to exercise rollingWeights copyWithin overlap normalization
    const left = new Float32Array(len).fill(0.25);
    const right = new Float32Array(len).fill(0.25);

    const fourOut = await proc.separate(left, right, { mode: "four_stem" });
    const twoOut = await proc.separate(left, right, { mode: "two_stem" });

    assert.equal("drums" in fourOut, true);
    assert.equal("drums" in twoOut, false);
    assert.equal(twoOut.mode, "two_stem");
    for (const checkIdx of [1000, 260000, 315000]) {
      assert.ok(Math.abs(twoOut.vocals.left[checkIdx] - 0.4) < 1e-5, `vocals at ${checkIdx}`);
      assert.ok(Math.abs(twoOut.vocals.left[checkIdx] - fourOut.vocals.left[checkIdx]) < 1e-6);
      const expectedInst = fourOut.drums.left[checkIdx] + fourOut.bass.left[checkIdx] + fourOut.other.left[checkIdx];
      assert.ok(Math.abs(expectedInst - 0.6) < 1e-5, `inst at ${checkIdx}`);
      assert.ok(Math.abs(twoOut.instrumental.left[checkIdx] - expectedInst) < 1e-6);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
