/**
 * node:test suite for the guest chord matcher and table validator (run via
 * `pnpm run test` after compile — the `window-open.test.ts` convention).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CHORD_CODE_MAX_LENGTH,
  findChord,
  matchChord,
  parseChordSpecs,
  WEB_CHORDS_MAX,
  type ChordInput,
  type ChordSpec,
} from "./chords";

function input(overrides: Partial<ChordInput> = {}): ChordInput {
  return {
    type: "keyDown",
    code: "KeyK",
    control: false,
    meta: false,
    shift: false,
    alt: false,
    ...overrides,
  };
}

function spec(overrides: Partial<ChordSpec> = {}): ChordSpec {
  return { code: "KeyK", ctrl: false, meta: false, shift: false, alt: false, ...overrides };
}

// ── matchChord ───────────────────────────────────────────────────────────────

test("a keyDown equal on code and every modifier matches", () => {
  assert.equal(matchChord(input({ control: true }), [spec({ ctrl: true })]), true);
});

test("keyUp never matches, even when everything else is equal", () => {
  assert.equal(matchChord(input({ type: "keyUp", control: true }), [spec({ ctrl: true })]), false);
});

test("modifiers must be EXACT — an extra shift rejects the cmd-tier spec", () => {
  assert.equal(
    matchChord(input({ control: true, shift: true }), [spec({ ctrl: true })]),
    false,
  );
});

test("alt is rejected unless the spec carries it (the SPA never emits alt specs)", () => {
  assert.equal(matchChord(input({ control: true, alt: true }), [spec({ ctrl: true })]), false);
  assert.equal(matchChord(input({ alt: true }), [spec({ alt: true })]), true);
});

test("Escape with no modifiers matches the always-present focus-return spec", () => {
  assert.equal(matchChord(input({ code: "Escape" }), [spec({ code: "Escape" })]), true);
});

test("cmd-tier expansion: ctrl and meta specs are distinct entries", () => {
  const table = [spec({ ctrl: true }), spec({ meta: true })];
  assert.equal(matchChord(input({ control: true }), table), true);
  assert.equal(matchChord(input({ meta: true }), table), true);
  assert.equal(matchChord(input({ control: true, meta: true }), table), false);
});

test("shifted-tier expansion matches shift+ctrl and shift+meta exactly", () => {
  const table = [spec({ ctrl: true, shift: true }), spec({ meta: true, shift: true })];
  assert.equal(matchChord(input({ control: true, shift: true }), table), true);
  assert.equal(matchChord(input({ meta: true, shift: true }), table), true);
  assert.equal(matchChord(input({ control: true }), table), false);
});

test("a plain letter keydown matches nothing in a chord table", () => {
  const table = [spec({ ctrl: true }), spec({ code: "Escape" })];
  assert.equal(matchChord(input({ code: "KeyA" }), table), false);
  assert.equal(matchChord(input({ code: "KeyA" }), []), false);
});

// ── parseChordSpecs ──────────────────────────────────────────────────────────

test("parses a well-formed table", () => {
  const parsed = parseChordSpecs([spec({ ctrl: true }), spec({ code: "Escape" })]);
  assert.deepEqual(parsed, [spec({ ctrl: true }), spec({ code: "Escape" })]);
});

test("an empty table is valid", () => {
  assert.deepEqual(parseChordSpecs([]), []);
});

test("non-arrays and tables past the entry cap are rejected", () => {
  assert.equal(parseChordSpecs("nope"), null);
  assert.equal(parseChordSpecs({}), null);
  assert.equal(parseChordSpecs(Array.from({ length: WEB_CHORDS_MAX + 1 }, () => spec())), null);
  assert.equal(parseChordSpecs(Array.from({ length: WEB_CHORDS_MAX }, () => spec()))?.length, WEB_CHORDS_MAX);
});

test("one bad entry rejects the whole payload", () => {
  assert.equal(parseChordSpecs([spec(), { code: "KeyK" }]), null);
  assert.equal(parseChordSpecs([spec(), spec({ code: "" })]), null);
  assert.equal(
    parseChordSpecs([spec({ code: "x".repeat(CHORD_CODE_MAX_LENGTH + 1) })]),
    null,
  );
  assert.equal(parseChordSpecs([spec({ code: "x".repeat(CHORD_CODE_MAX_LENGTH) })])?.length, 1);
});

test("non-boolean modifiers are rejected", () => {
  assert.equal(parseChordSpecs([{ ...spec(), ctrl: 1 }]), null);
  assert.equal(parseChordSpecs([{ ...spec(), meta: "yes" }]), null);
  assert.equal(parseChordSpecs([{ ...spec(), shift: undefined }]), null);
  assert.equal(parseChordSpecs([{ ...spec(), alt: null }]), null);
});

// ── keepFocus (web keyboard-capture toggle) ─────────────────────────────────

test("keepFocus survives the parse when true and is omitted otherwise", () => {
  const parsed = parseChordSpecs([
    spec({ code: "KeyG", shift: true, ctrl: true, keepFocus: true }),
    spec({ keepFocus: false }),
    spec(),
  ]);
  assert.equal(parsed?.[0]?.keepFocus, true);
  assert.equal("keepFocus" in (parsed?.[1] ?? {}), false);
  assert.equal("keepFocus" in (parsed?.[2] ?? {}), false);
});

test("a non-boolean keepFocus rejects the whole payload", () => {
  assert.equal(parseChordSpecs([{ ...spec(), keepFocus: "yes" }]), null);
});

test("findChord returns the matched spec so main can read keepFocus", () => {
  const table = [spec({ ctrl: true }), spec({ code: "KeyG", ctrl: true, shift: true, keepFocus: true })];
  assert.equal(findChord(input({ code: "KeyG", control: true, shift: true }), table)?.keepFocus, true);
  assert.equal(findChord(input({ control: true }), table)?.keepFocus, undefined);
  assert.equal(findChord(input({ code: "KeyZ" }), table), undefined);
});
