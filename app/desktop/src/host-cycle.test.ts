/**
 * node:test suite for the pure host-cycle model (run via `pnpm run test`
 * after compile — the `hosts.test.ts` convention).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { adjacentHostId, hostCycleMenuItems } from "./host-cycle";

const abc = ["a", "b", "c"];

test("adjacentHostId steps forward and backward through the list", () => {
  assert.equal(adjacentHostId(abc, "a", 1), "b");
  assert.equal(adjacentHostId(abc, "b", -1), "a");
  assert.equal(adjacentHostId(abc, "b", 1), "c");
});

test("adjacentHostId wraps at both ends", () => {
  assert.equal(adjacentHostId(abc, "c", 1), "a");
  assert.equal(adjacentHostId(abc, "a", -1), "c");
});

test("adjacentHostId with two hosts alternates in both directions", () => {
  assert.equal(adjacentHostId(["a", "b"], "a", 1), "b");
  assert.equal(adjacentHostId(["a", "b"], "a", -1), "b");
  assert.equal(adjacentHostId(["a", "b"], "b", 1), "a");
});

test("adjacentHostId is null below two hosts", () => {
  assert.equal(adjacentHostId(["a"], "a", 1), null);
  assert.equal(adjacentHostId(["a"], "a", -1), null);
  assert.equal(adjacentHostId([], null, 1), null);
  assert.equal(adjacentHostId([], null, -1), null);
});

test("adjacentHostId from no current host starts before the first", () => {
  assert.equal(adjacentHostId(abc, null, 1), "a");
  assert.equal(adjacentHostId(abc, null, -1), "c");
  assert.equal(adjacentHostId(abc, "gone", 1), "a");
  assert.equal(adjacentHostId(abc, "gone", -1), "c");
});

test("hostCycleMenuItems is empty below two hosts on every platform", () => {
  for (const isMac of [true, false]) {
    assert.deepEqual(hostCycleMenuItems(isMac, 0), []);
    assert.deepEqual(hostCycleMenuItems(isMac, 1), []);
  }
});

test("hostCycleMenuItems binds ⌥⌘←/→ on mac, Previous before Next", () => {
  assert.deepEqual(hostCycleMenuItems(true, 2), [
    { label: "Previous Host", accelerator: "Alt+Cmd+Left", direction: -1 },
    { label: "Next Host", accelerator: "Alt+Cmd+Right", direction: 1 },
  ]);
});

test("hostCycleMenuItems binds Alt+PageUp/PageDown on win/linux", () => {
  assert.deepEqual(hostCycleMenuItems(false, 3), [
    { label: "Previous Host", accelerator: "Alt+PageUp", direction: -1 },
    { label: "Next Host", accelerator: "Alt+PageDown", direction: 1 },
  ]);
});
