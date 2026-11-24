/**
 * node:test suite for the desktop prefs store (run via `pnpm run test` after
 * compile — the `windows.test.ts` convention).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPrefs, isPrefsUpdate, loadPrefs, savePrefs, setPref } from "./prefs";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "rk-desktop-prefs-"));
}

test("loadPrefs returns the defaults (glow + slide) for a missing file", () => {
  assert.deepEqual(loadPrefs(tmpDataDir()), {
    strip: { effect: "glow", motion: "slide" },
  });
});

test("loadPrefs returns the defaults for corrupt JSON", () => {
  const dir = tmpDataDir();
  writeFileSync(join(dir, "prefs.json"), "{ not json", "utf8");
  assert.deepEqual(loadPrefs(dir), defaultPrefs());
});

test("loadPrefs falls back per key: an unknown value keeps the other key", () => {
  const dir = tmpDataDir();
  writeFileSync(
    join(dir, "prefs.json"),
    JSON.stringify({ version: 1, strip: { effect: "plaid", motion: "cut" } }),
    "utf8",
  );
  assert.deepEqual(loadPrefs(dir), { strip: { effect: "glow", motion: "cut" } });
});

test("loadPrefs tolerates a wrong-shape strip value", () => {
  const dir = tmpDataDir();
  writeFileSync(join(dir, "prefs.json"), JSON.stringify({ strip: "hex" }), "utf8");
  assert.deepEqual(loadPrefs(dir), defaultPrefs());
});

test("savePrefs round-trips and leaves no tmp file behind", () => {
  const dir = tmpDataDir();
  savePrefs(dir, { strip: { effect: "hex", motion: "sweep" } });
  assert.deepEqual(loadPrefs(dir), { strip: { effect: "hex", motion: "sweep" } });
  assert.deepEqual(readdirSync(dir), ["prefs.json"]);
  assert.match(readFileSync(join(dir, "prefs.json"), "utf8"), /"version": 1/);
});

test("setPref persists a valid update and returns the new prefs", () => {
  const dir = tmpDataDir();
  const next = setPref(dir, "strip.effect", "edge");
  assert.deepEqual(next, { strip: { effect: "edge", motion: "slide" } });
  assert.equal(loadPrefs(dir).strip.effect, "edge");
  assert.equal(setPref(dir, "strip.motion", "cut")?.strip.motion, "cut");
  assert.deepEqual(loadPrefs(dir), { strip: { effect: "edge", motion: "cut" } });
});

test("setPref rejects keys and values outside the closed sets without writing", () => {
  const dir = tmpDataDir();
  assert.equal(setPref(dir, "strip.effect", "plaid"), null);
  assert.equal(setPref(dir, "strip.motion", "glow"), null);
  assert.equal(setPref(dir, "strip.size", "glow"), null);
  assert.equal(setPref(dir, 7, "glow"), null);
  assert.deepEqual(readdirSync(dir), []);
});

test("isPrefsUpdate pairs each key with its own closed set", () => {
  assert.equal(isPrefsUpdate("strip.effect", "flat"), true);
  assert.equal(isPrefsUpdate("strip.effect", "cut"), false);
  assert.equal(isPrefsUpdate("strip.motion", "cut"), true);
  assert.equal(isPrefsUpdate("strip.motion", "flat"), false);
});
