/**
 * Guest chord forwarding pure logic — the SPA uploads a per-guest chord table
 * (`web:chords`) and main matches `before-input-event` against it.
 *
 * Deliberately electron-free (the `window-open.ts` pattern): the matcher and
 * the payload validator are pure, so `chords.test.ts` covers them under plain
 * `node --test`. The impure half — attaching `before-input-event`,
 * `preventDefault`, the host focus hop, the `chord` relay — lives in
 * `main.ts`'s `wireGuestRelay`.
 *
 * The table is the reclaim predicate, enumerated SPA-side from the keybinding
 * registry: main stays dumb — a keydown matches iff some spec equals the input
 * on `code` and all four modifiers EXACTLY (Electron's `control` field maps to
 * the spec's `ctrl`). Only `keyDown` matches; `keyUp`/`char`/`rawKeyDown`
 * never do. Auto-repeat is deliberately not filtered: a held chord repeats its
 * action exactly as it does in the SPA's own document.
 */

/** The relayed table is renderer-supplied data over IPC — bounded like every
 *  other `web:*` payload. The SPA's registry expands to well under 100 specs. */
export const WEB_CHORDS_MAX = 256;
/** A key code is a short DOM token ("KeyK", "Escape") — bounded structurally. */
export const CHORD_CODE_MAX_LENGTH = 64;

/** One reclaimable chord: a key code plus its exact modifier set.
 *  `keepFocus` skips main's host focus hop for this chord (the web
 *  keyboard-capture toggle: its result is "keep typing in the page", so
 *  focus must stay in the guest). Optional — an older SPA never sends it. */
export interface ChordSpec {
  code: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  keepFocus?: boolean;
}

/** The slice of a `before-input-event` Input the matcher reads. */
export interface ChordInput {
  type: string;
  code: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

function isChordSpec(value: unknown): value is ChordSpec {
  if (typeof value !== "object" || value === null) return false;
  if (!("code" in value) || typeof value.code !== "string") return false;
  if (value.code.length === 0 || value.code.length > CHORD_CODE_MAX_LENGTH) return false;
  if (!("ctrl" in value) || typeof value.ctrl !== "boolean") return false;
  if (!("meta" in value) || typeof value.meta !== "boolean") return false;
  if (!("shift" in value) || typeof value.shift !== "boolean") return false;
  if (!("alt" in value) || typeof value.alt !== "boolean") return false;
  if ("keepFocus" in value && value.keepFocus !== undefined && typeof value.keepFocus !== "boolean") return false;
  return true;
}

/** Structural validation of a `web:chords` table; null rejects the whole
 *  payload (one bad entry poisons the match set, so partial acceptance is
 *  wrong here — unlike the favicon list, nothing degrades gracefully). */
export function parseChordSpecs(value: unknown): ChordSpec[] | null {
  if (!Array.isArray(value) || value.length > WEB_CHORDS_MAX) return null;
  const specs: ChordSpec[] = [];
  for (const entry of value) {
    if (!isChordSpec(entry)) return null;
    const spec: ChordSpec = {
      code: entry.code,
      ctrl: entry.ctrl,
      meta: entry.meta,
      shift: entry.shift,
      alt: entry.alt,
    };
    if (entry.keepFocus === true) spec.keepFocus = true;
    specs.push(spec);
  }
  return specs;
}

/** True iff a keyDown equals some spec on the code and every modifier. */
export function matchChord(input: ChordInput, chords: readonly ChordSpec[]): boolean {
  return findChord(input, chords) !== undefined;
}

/** The spec a keyDown matches (code + every modifier), or undefined. */
export function findChord(input: ChordInput, chords: readonly ChordSpec[]): ChordSpec | undefined {
  if (input.type !== "keyDown") return undefined;
  return chords.find(
    (spec) =>
      spec.code === input.code &&
      spec.ctrl === input.control &&
      spec.meta === input.meta &&
      spec.shift === input.shift &&
      spec.alt === input.alt,
  );
}
