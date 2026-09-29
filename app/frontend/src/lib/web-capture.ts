/**
 * The web tile's keyboard-capture latch (`rk-web-capture`) — the gui latch's
 * (`rk-gui-capture`, `lib/gui-posture.ts`) mirror for the `web` surface.
 *
 * Per-viewer localStorage ("1" = captured, absent/other = released), never
 * POSTed (Constitution IV). While latched, BOTH web engines hand every chord
 * to the page except the release binding (`web-capture-toggle`, ⌘⇧G):
 * the iframe engine through the narrowed `hasReclaimableMatch` predicate, the
 * native engine through the narrowed `buildWebChordTable`. Reads and writes
 * degrade to "released" / no-op when storage is unavailable.
 */

const WEB_CAPTURE_KEY = "rk-web-capture";

/** The stored latch; false (released) when unset, malformed, or unreadable. */
export function readWebCapture(): boolean {
  try {
    return localStorage.getItem(WEB_CAPTURE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the latch — captured writes "1", released removes the key. */
export function writeWebCapture(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(WEB_CAPTURE_KEY, "1");
    } else {
      localStorage.removeItem(WEB_CAPTURE_KEY);
    }
  } catch {
    // Storage unavailable (private mode / quota) — the in-memory latch still
    // governs this session.
  }
}
