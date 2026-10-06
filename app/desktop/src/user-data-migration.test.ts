/**
 * node:test suite for the userData carry-forward and legacy-dir retirement
 * (run via `pnpm run test` after compile — the `hosts.test.ts` convention).
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { carryForwardLegacyUserData, retireLegacyUserData } from "./user-data-migration";

function fixture(): { root: string; newDir: string; legacyDir: string } {
  const root = mkdtempSync(join(tmpdir(), "user-data-migration-"));
  return { root, newDir: join(root, "HexoKit"), legacyDir: join(root, "Run Kit") };
}

function captureWarnings<T>(fn: () => T): { result: T; warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test("copies hosts.json and windows.json when the new dir is empty", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "hosts.json"), '{"version":1}');
  writeFileSync(join(legacyDir, "windows.json"), '{"version":1,"windows":[]}');

  const { copied, failed } = carryForwardLegacyUserData(newDir, legacyDir);
  assert.equal(failed, false);
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

  try {
    const { result, warnings } = captureWarnings(() =>
      carryForwardLegacyUserData(newDir, legacyDir),
    );
    assert.deepEqual(result.copied, []);
    assert.equal(result.failed, true, "a failed carry-forward must be reported");
    assert.ok(!existsSync(join(newDir, "hosts.json")));
    assert.equal(warnings.length, 1, "a failure must be logged, not swallowed");
  } finally {
    chmodSync(hosts, 0o644);
  }
});

test("a failure after a partial copy rolls back, and the next start retries", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "hosts.json"), '{"version":1}');
  const windows = join(legacyDir, "windows.json");
  writeFileSync(windows, '{"version":1,"windows":[]}');
  chmodSync(windows, 0o000); // hosts.json copies, then windows.json throws

  try {
    const { result, warnings } = captureWarnings(() =>
      carryForwardLegacyUserData(newDir, legacyDir),
    );
    assert.deepEqual(result, { copied: [], failed: true });
    assert.equal(warnings.length, 1);
    assert.ok(!existsSync(join(newDir, "hosts.json")), "the partial copy must be rolled back");
    assert.deepEqual(retireLegacyUserData(newDir, legacyDir), { removed: false });
  } finally {
    chmodSync(windows, 0o644);
  }

  const retried = carryForwardLegacyUserData(newDir, legacyDir);
  assert.equal(retried.failed, false);
  assert.deepEqual(retried.copied.sort(), ["hosts.json", "windows.json"]);
});

test("skips a store the new dir already has instead of failing", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(newDir, { recursive: true });
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(newDir, "windows.json"), '{"version":1,"windows":["new"]}');
  writeFileSync(join(legacyDir, "hosts.json"), '{"version":1}');
  writeFileSync(join(legacyDir, "windows.json"), '{"version":1,"windows":[]}');

  const { copied, failed } = carryForwardLegacyUserData(newDir, legacyDir);
  assert.equal(failed, false);
  assert.deepEqual(copied, ["hosts.json"]);
  assert.equal(readFileSync(join(newDir, "windows.json"), "utf8"), '{"version":1,"windows":["new"]}');
});

test("retire removes the legacy dir recursively once the new dir has hosts.json", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(newDir, { recursive: true });
  writeFileSync(join(newDir, "hosts.json"), '{"version":1}');
  mkdirSync(join(legacyDir, "Cache"), { recursive: true });
  writeFileSync(join(legacyDir, "hosts.json"), '{"version":1,"old":true}');
  writeFileSync(join(legacyDir, "Cache", "data_0"), "x");

  assert.deepEqual(retireLegacyUserData(newDir, legacyDir), { removed: true });
  assert.ok(!existsSync(legacyDir));
  assert.equal(readFileSync(join(newDir, "hosts.json"), "utf8"), '{"version":1}');
});

test("retire keeps the legacy dir while the new dir has no hosts.json", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "hosts.json"), '{"version":1}');

  assert.deepEqual(retireLegacyUserData(newDir, legacyDir), { removed: false });
  assert.ok(existsSync(join(legacyDir, "hosts.json")));
});

test("retire is a silent no-op when the legacy dir is absent", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(newDir, { recursive: true });
  writeFileSync(join(newDir, "hosts.json"), '{"version":1}');

  const { result, warnings } = captureWarnings(() => retireLegacyUserData(newDir, legacyDir));
  assert.deepEqual(result, { removed: false });
  assert.equal(warnings.length, 0);
});

test("retire removes only the link when the legacy path is a symlink", () => {
  const { root, newDir, legacyDir } = fixture();
  mkdirSync(newDir, { recursive: true });
  writeFileSync(join(newDir, "hosts.json"), '{"version":1}');
  const target = join(root, "elsewhere");
  mkdirSync(target);
  writeFileSync(join(target, "keep.txt"), "keep");
  symlinkSync(target, legacyDir, "dir");

  assert.deepEqual(retireLegacyUserData(newDir, legacyDir), { removed: true });
  assert.equal(lstatSync(legacyDir, { throwIfNoEntry: false }), undefined);
  assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "keep");
});

test("retire logs and ignores a failed delete", () => {
  const { root, newDir, legacyDir } = fixture();
  mkdirSync(newDir, { recursive: true });
  writeFileSync(join(newDir, "hosts.json"), '{"version":1}');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "hosts.json"), '{"version":1}');
  chmodSync(root, 0o500); // a read-only parent makes the legacy dir undeletable

  try {
    const { result, warnings } = captureWarnings(() => retireLegacyUserData(newDir, legacyDir));
    assert.deepEqual(result, { removed: false });
    assert.equal(warnings.length, 1, "a failure must be logged, not swallowed");
  } finally {
    chmodSync(root, 0o755);
  }
  // The recursive delete may have emptied the dir before failing on it.
  assert.ok(existsSync(legacyDir));
});

test("a pre-rename jump carries the stores forward, then retires the legacy dir", () => {
  const { newDir, legacyDir } = fixture();
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "hosts.json"), '{"version":1}');
  writeFileSync(join(legacyDir, "windows.json"), '{"version":1,"windows":[]}');

  const carried = carryForwardLegacyUserData(newDir, legacyDir);
  assert.equal(carried.failed, false);
  assert.deepEqual(retireLegacyUserData(newDir, legacyDir), { removed: true });
  assert.equal(readFileSync(join(newDir, "hosts.json"), "utf8"), '{"version":1}');
  assert.equal(readFileSync(join(newDir, "windows.json"), "utf8"), '{"version":1,"windows":[]}');
  assert.ok(!existsSync(legacyDir));
});
