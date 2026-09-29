/**
 * node:test suite for the userData carry-forward (run via `pnpm run test`
 * after compile — the `hosts.test.ts` convention).
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { carryForwardLegacyUserData } from "./user-data-migration";

function fixture(): { newDir: string; legacyDir: string } {
  const root = mkdtempSync(join(tmpdir(), "user-data-migration-"));
  return { newDir: join(root, "HexoKit"), legacyDir: join(root, "Run Kit") };
}

test("copies hosts.json and windows.json when the new dir is empty", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "hosts.json"), '{"version":1}');
  writeFileSync(join(legacyDir, "windows.json"), '{"version":1,"windows":[]}');

  const { copied } = carryForwardLegacyUserData(newDir, legacyDir);
  assert.deepEqual(copied.sort(), ["hosts.json", "windows.json"]);
  assert.equal(readFileSync(join(newDir, "hosts.json"), "utf8"), '{"version":1}');
  assert.equal(readFileSync(join(newDir, "windows.json"), "utf8"), '{"version":1,"windows":[]}');
  // Copy, not move: the legacy files remain for a possible downgrade.
  assert.equal(readFileSync(join(legacyDir, "hosts.json"), "utf8"), '{"version":1}');
  assert.equal(readFileSync(join(legacyDir, "windows.json"), "utf8"), '{"version":1,"windows":[]}');
});

test("copies windows.json only when present", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "hosts.json"), '{"version":1}');

  const { copied } = carryForwardLegacyUserData(newDir, legacyDir);
  assert.deepEqual(copied, ["hosts.json"]);
  assert.ok(existsSync(join(newDir, "hosts.json")));
  assert.ok(!existsSync(join(newDir, "windows.json")));
});

test("no-op when the new dir already has hosts.json — never overwrites", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(newDir, { recursive: true });
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(newDir, "hosts.json"), '{"version":1,"new":true}');
  writeFileSync(join(legacyDir, "hosts.json"), '{"version":1,"old":true}');
  writeFileSync(join(legacyDir, "windows.json"), '{"version":1,"windows":[]}');

  const { copied } = carryForwardLegacyUserData(newDir, legacyDir);
  assert.deepEqual(copied, []);
  assert.equal(readFileSync(join(newDir, "hosts.json"), "utf8"), '{"version":1,"new":true}');
  assert.ok(!existsSync(join(newDir, "windows.json")));
});

test("no-op when the legacy dir has no hosts.json (or is absent)", () => {
  const { newDir, legacyDir } = fixture();

  const absent = carryForwardLegacyUserData(newDir, legacyDir);
  assert.deepEqual(absent.copied, []);
  assert.ok(!existsSync(join(newDir, "hosts.json")));

  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "windows.json"), '{"version":1,"windows":[]}');
  const noHosts = carryForwardLegacyUserData(newDir, legacyDir);
  assert.deepEqual(noHosts.copied, []);
  assert.ok(!existsSync(join(newDir, "hosts.json")));
  assert.ok(!existsSync(join(newDir, "windows.json")));
});

test("logs and ignores a copy failure — fresh-install degradation", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(legacyDir, { recursive: true });
  const hosts = join(legacyDir, "hosts.json");
  writeFileSync(hosts, '{"version":1}');
  chmodSync(hosts, 0o000); // unreadable source forces the copy to throw

  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const { copied } = carryForwardLegacyUserData(newDir, legacyDir);
    assert.deepEqual(copied, []);
    assert.ok(!existsSync(join(newDir, "hosts.json")));
  } finally {
    console.warn = original;
    chmodSync(hosts, 0o644);
  }
  assert.equal(warnings.length, 1, "a failure must be logged, not swallowed");
});
