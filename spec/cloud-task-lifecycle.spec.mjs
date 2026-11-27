import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("provider wakes durable tasks on lifecycle/network/auth events without cancelling on hidden", async () => {
  const provider = await readFile(new URL("../components/providers/CloudTaskProvider.tsx", import.meta.url), "utf8");
  for (const eventName of ["visibilitychange", "pagehide", "pageshow", "online", "offline", "focus"]) assert.match(provider, new RegExp(eventName));
  assert.match(provider, /visibilityState === "visible"/);
  assert.doesNotMatch(provider, /\.cancel\(/);
  assert.doesNotMatch(provider, /\.abort\(/);
});
