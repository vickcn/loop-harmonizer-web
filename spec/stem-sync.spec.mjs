import assert from "node:assert/strict";
import test from "node:test";

let getLinkedStemTrackIds;
let calculateStemOffsetSpread;

try {
  ({ getLinkedStemTrackIds, calculateStemOffsetSpread } = await import("../lib/band/stemSync.ts"));
} catch {
  // The assertion below intentionally fails until group synchronization exists.
}

test("a grouped stem seek includes every track from its source song", () => {
  const trackIds = getLinkedStemTrackIds([
    { id: "vocals", stemMetadata: { sourceGroupId: "song_a" } },
    { id: "drums", stemMetadata: { sourceGroupId: "song_a" } },
    { id: "manual" },
    { id: "bass", stemMetadata: { sourceGroupId: "song_a" } },
  ], "drums");

  assert.deepEqual(trackIds, ["vocals", "drums", "bass"]);
});

test("stem offset diagnostic reports the widest playback drift", () => {
  const spread = calculateStemOffsetSpread({ vocals: 10.005, drums: 10.017, bass: 10.011, other: 10.006 });
  assert.ok(Math.abs(spread - 0.012) < 0.000001);
});
