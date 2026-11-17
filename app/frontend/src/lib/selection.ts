/**
 * Pure selection logic for the sidebar's window-row multi-select (260807-nf9f).
 *
 * Dependency-free (no React, no zustand, no API) so the range arithmetic,
 * single-server derivation, and pruning are unit-testable without mounting the
 * tree — the same discipline as lib/palette/move.ts and lib/board-reorder.ts.
 * The store (store/selection-store.ts) and the sidebar tree are thin consumers.
 *
 * The selection is keyed by the SAME composite `${server}:${windowId}` key the
 * rest of the app already uses as a globally-unique window handle: the window
 * store's `entryKey()` and the sidebar's roving `data-row-key`. tmux window ids
 * (`@N`) are unique per server only, so the server prefix is required.
 */

/** Compose the composite selection key. Mirrors `entryKey()` in store/window-store.ts. */
export function selectionKey(server: string, windowId: string): string {
  return `${server}:${windowId}`;
}

/**
 * Split a composite selection key back into its parts. Splits at the FIRST `:`
 * — tmux server names cannot contain `:` but a window id theoretically could,
 * so the server is the prefix and everything after the first separator is the
 * window id. Returns `null` for a malformed key (no separator).
 */
export function splitSelectionKey(
  key: string,
): { server: string; windowId: string } | null {
  const sep = key.indexOf(":");
  if (sep < 0) return null;
  return { server: key.slice(0, sep), windowId: key.slice(sep + 1) };
}

/**
 * The inclusive contiguous range of keys between `anchorKey` and `targetKey` in
 * `orderedKeys` (visible-row order). Direction-independent: the anchor may sit
 * before or after the target. Returns `[]` when either endpoint is absent from
 * the list (a stale anchor whose row has since disappeared), so a caller can
 * treat the empty result as "no range — fall back to a plain toggle".
 */
export function rangeBetween(
  orderedKeys: readonly string[],
  anchorKey: string,
  targetKey: string,
): string[] {
  const from = orderedKeys.indexOf(anchorKey);
  const to = orderedKeys.indexOf(targetKey);
  if (from < 0 || to < 0) return [];
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return orderedKeys.slice(lo, hi + 1);
}

/**
 * The single server every selected key belongs to, or `null` when the selection
 * is empty or spans more than one server. This is the bulk-move gate: tmux
 * cannot move a window across tmux servers (the existing drag-and-drop path
 * already rejects cross-server drops), so a cross-server selection offers no
 * move targets at all.
 */
export function singleSelectedServer(
  selectedKeys: Iterable<string>,
): string | null {
  let found: string | null = null;
  for (const key of selectedKeys) {
    const parts = splitSelectionKey(key);
    if (!parts) return null; // malformed key — treat as ineligible
    if (found === null) {
      found = parts.server;
    } else if (found !== parts.server) {
      return null;
    }
  }
  return found;
}

/**
 * Drop selected keys whose rows are no longer live (window killed, or moved to
 * a server/session that is not currently rendered).
 *
 * `liveKeys` is the DATA-derived live-key set — every window the SSE snapshot
 * knows for the rendered server groups, expanded or collapsed — NOT the
 * visible/rendered row set: a visibility-keyed liveness would read a merely
 * collapsed session as departed and silently destroy the selection of its
 * still-live windows.
 *
 * Returns the SAME set instance when nothing was dropped, so the caller can
 * bail without a state write — the sidebar prunes on every change of that
 * data-derived key-set signature (`dataKeysVersion`), and the overwhelmingly
 * common case is "nothing to do".
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  liveKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  let anyMissing = false;
  for (const key of selected) {
    if (!liveKeys.has(key)) {
      anyMissing = true;
      break;
    }
  }
  if (!anyMissing) return selected;
  const next = new Set<string>();
  for (const key of selected) {
    if (liveKeys.has(key)) next.add(key);
  }
  return next;
}

/**
 * How a selection gesture (Cmd/Ctrl-click, Shift-click, `x`) on `targetKey`
 * treats the open tab, so single select behaves as a selection of one:
 *
 * - `"seed"` — the store is empty and the open tab is a live window other than
 *   the target: add the open tab first (it becomes the anchor), then apply the
 *   gesture on top.
 * - `"noop"` — the store is empty and the target IS the open tab: it is
 *   already the implicit selection of one, so the gesture is consumed and
 *   changes nothing.
 * - `"none"` — no open tab to seed (no open window, or one the tree does not
 *   know), or a selection is already live: apply the gesture as-is.
 *
 * `liveKeys` is the same DATA-derived live-key set `pruneSelection` takes, so
 * a ghost or not-yet-rendered open tab is never seeded.
 */
export function openTabSeed(
  selectedSize: number,
  openKey: string | null,
  targetKey: string,
  liveKeys: ReadonlySet<string>,
): "seed" | "noop" | "none" {
  if (selectedSize > 0 || openKey === null) return "none";
  if (openKey === targetKey) return "noop";
  return liveKeys.has(openKey) ? "seed" : "none";
}
