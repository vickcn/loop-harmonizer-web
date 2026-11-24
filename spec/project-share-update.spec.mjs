import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyProject } from "../lib/projects/projectModel.ts";
import { buildProjectShareManifest, buildProjectSharePointer } from "../lib/sharing/shareManifest.ts";

test("new shared revision is immutable and does not mutate old snapshot", () => {
  const project = createEmptyProject({ name: "P", storageProvider: "google_drive", ownerAccountId: "owner" });
  const old = buildProjectShareManifest({ shareId: "s", sourceProject: project, ownerAccountId: "owner", publishedRevisionId: "p1", songs: [] });
  project.name = "P updated"; project.revision = 2;
  const next = buildProjectShareManifest({ shareId: "s", sourceProject: project, ownerAccountId: "owner", publishedRevisionId: "p2", songs: [] });
  assert.equal(old.project.name, "P"); assert.equal(old.publishedRevisionId, "p1");
  assert.equal(next.project.name, "P updated"); assert.equal(next.publishedRevisionId, "p2");
  assert.equal(buildProjectSharePointer({ manifest: old, revisionManifestFileId: "f1", visibility: "restricted" }).revisionManifestFileId, "f1");
  assert.equal(buildProjectSharePointer({ manifest: next, revisionManifestFileId: "f2", visibility: "restricted" }).revisionManifestFileId, "f2");
});
