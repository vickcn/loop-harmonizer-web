import assert from "node:assert/strict";
import test from "node:test";

import { mapCheckpointStatusToJobStage, mapJobStageToSongSeparationStatus } from "../lib/separation/separationJobManager.ts";

test("completed checkpoint is finalizing until the authoritative song result is committed", () => {
  const checkpoint = { status: "completed" };
  assert.equal(
    mapCheckpointStatusToJobStage(checkpoint, { hasActiveLocalController: false, hasActiveForeignOwner: false }),
    "finalizing",
  );
  assert.equal(
    mapCheckpointStatusToJobStage(checkpoint, {
      hasActiveLocalController: false,
      hasActiveForeignOwner: false,
      isFinalized: true,
    }),
    "completed",
  );
  assert.equal(mapJobStageToSongSeparationStatus("finalizing"), "processing");
});
