import assert from "node:assert/strict";
import test from "node:test";

let getLinkedStemTrackIds;

try {
  ({ getLinkedStemTrackIds } = await import("../lib/band/stemSync.ts"));
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
