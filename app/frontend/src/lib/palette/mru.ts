/**
 * Per-viewer recency memory for command-palette action ids, backing the MRU
 * tiebreak in `lib/palette/rank.ts`: a recently-used action rises above an
 * equal-quality untouched one, and an empty query lists recent actions first.
 *
 * Per-client only (Constitution II — no backend persistence); the key joins
 * the established `runkit-*` family. The stored value is a JSON array of
 * action ids, most-recent-first. Reads/writes are best-effort with the
 * try/catch-noop pattern from `lib/last-window-per-server.ts` so private
 * mode / quota / SSR never throw.
 */
export const PALETTE_MRU_KEY = "hexokit-palette-mru";

/** Cap — most-recent-first, oldest evicted. */
export const PALETTE_MRU_LIMIT = 20;

/**
 * Read the id list, most-recent-first. Returns `[]` when the key is absent,
 * the payload is not a JSON array of strings, or localStorage is
 * unavailable. Never throws.
 */
export function readPaletteMru(): string[] {
  try {
    const raw = localStorage.getItem(PALETTE_MRU_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/**
 * Push `id` to the front (deduping any earlier occurrence), truncate to the
 * cap, and persist best-effort. Returns the new list; a persistence failure
 * is swallowed.
 */
export function recordPaletteUse(id: string): string[] {
  const next = [id, ...readPaletteMru().filter((existing) => existing !== id)];
  const capped = next.slice(0, PALETTE_MRU_LIMIT);
  try {
    localStorage.setItem(PALETTE_MRU_KEY, JSON.stringify(capped));
  } catch {
    /* noop — best-effort persistence */
  }
  return capped;
}
