import assert from "node:assert/strict";
import test from "node:test";

let calculateGlobalPlaybackRate;
let normalizeKeyShift;

try {
  ({ calculateGlobalPlaybackRate, normalizeKeyShift } = await import("../lib/band/globalPlaybackControls.ts"));
} catch {
  // The assertions below intentionally fail until the global control helpers exist.
}

test("global BPM derives the requested tempo ratio without changing Key", () => {
  assert.equal(calculateGlobalPlaybackRate(120, 120), 1);
  assert.equal(calculateGlobalPlaybackRate(150, 120), 1.25);
  assert.equal(calculateGlobalPlaybackRate(96, 120), 0.8);
});

test("global Key is always constrained to the supported octave", () => {
  assert.equal(normalizeKeyShift(3), 3);
  assert.equal(normalizeKeyShift(-2), -2);
  assert.equal(normalizeKeyShift(20), 12);
  assert.equal(normalizeKeyShift(-20), -12);
});
