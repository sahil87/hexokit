import { create } from "zustand";
import { pruneSelection } from "@/lib/selection";

/**
 * Sidebar window-row multi-select state (260807-nf9f).
 *
 * A dedicated store rather than sidebar-local `useState` because the two
 * consumers live in different subtrees: the tree that paints and mutates the
 * selection is `components/sidebar/index.tsx`, while the command palette that
 * ACTS on it is composed in `app.tsx`. Follows the `window-store.ts` pattern
 * (plain zustand `create`, actions colocated with state).
 *
 * Keys are the composite `${server}:${windowId}` handle — the same key the
 * window store's `entryKey()` and the sidebar's roving `data-row-key` use, since
 * tmux window ids (`@N`) are unique per server only. All the set arithmetic
 * lives in the pure `lib/selection.ts`; this store only holds state.
 *
 * Selection is WINDOW-ROWS-ONLY: session and server rows are never selectable
 * (each window is a worktree/change and PR status is per-window), and ghost /
 * optimistic rows (no real windowId) are excluded by the callers' guards.
 */
type SelectionStoreState = {
  /** Selected window rows, keyed by `${server}:${windowId}`. */
  selected: ReadonlySet<string>;
  /**
   * The last row toggled by an unmodified selection gesture (Cmd/Ctrl-click or
   * `x`) — the fixed end of a subsequent Shift-click range. `null` when no
   * anchor is established (fresh page, or after a clear).
   */
  anchor: string | null;
};

type SelectionStoreActions = {
  /** Flip one key's membership and move the anchor to it. */
  toggle: (key: string) => void;
  /** Add keys to the selection (anchor untouched). */
  select: (keys: Iterable<string>) => void;
  /**
   * Start a selection from `key` — the open tab — making it the anchor. Only
   * an EMPTY selection is seeded; a live one is left untouched, so a seed can
   * never clobber a set the user already built.
   */
  seed: (key: string) => void;
  /**
   * Replace the whole selection with `keys`; the anchor becomes the last key.
   * `Selection: Select all merged` is the production caller.
   *
   * A separate `deselect(keys)` was deliberately dropped from the store — it had
   * no production call site: every real removal path is already covered
   * (`toggle` for one row, `clear` for Escape / plain click, `prune` for windows
   * leaving the SSE data, `settleBatch` for an async batch's own keys, and this
   * for a wholesale replacement).
   *
   * An explicit `setAnchor(key)` was dropped for the same reason: every action
   * that should move the anchor already moves it as part of its own write
   * (`toggle` onto the flipped row, `selectOnly` onto the last key, `clear` /
   * `prune` / `settleBatch` dropping a stale one), so no consumer ever needed to
   * set it standalone.
   */
  selectOnly: (keys: Iterable<string>) => void;
  /**
   * Settle an async batch that OWNED `batchKeys`, retaining only `retainKeys`
   * (⊆ `batchKeys`) of them and leaving every key the batch did not own exactly
   * as it is.
   *
   * The bulk move is fire-and-forget behind a palette that has already closed,
   * so a slow batch races the user: they can build a whole NEW selection while
   * it is still POSTing. A terminal `clear()` / `selectOnly(failedKeys)` acts on
   * whatever the store holds at settle time and would silently destroy that new
   * selection. Reconciling against the batch's own keys makes the batch's write
   * scoped, so concurrent batches and a concurrent user selection all survive.
   *
   * The anchor is dropped only when it pointed at one of the batch's REMOVED
   * keys (a stale anchor would silently yield an empty range on the next
   * Shift-click); an anchor the user has since moved elsewhere is untouched.
   */
  settleBatch: (batchKeys: Iterable<string>, retainKeys: Iterable<string>) => void;
  /** Empty the selection and drop the anchor. */
  clear: () => void;
  /**
   * Drop selected keys whose windows are no longer live. Callers pass the
   * DATA-derived live-key set — every window the SSE snapshot knows for the
   * rendered server groups, expanded or collapsed — NOT the visible/rendered row
   * set: a visibility-keyed liveness would read a merely-collapsed session as
   * departed and silently destroy the selection of its still-live windows.
   * A prune that changes nothing performs no state write (`pruneSelection`
   * returns the same instance), so this is safe to call on every data-key
   * set-signature change.
   */
  prune: (liveKeys: ReadonlySet<string>) => void;
};

export const useSelectionStore = create<SelectionStoreState & SelectionStoreActions>((set) => ({
  selected: new Set<string>(),
  anchor: null,

  toggle: (key) => {
    set((state) => {
      const next = new Set(state.selected);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return { selected: next, anchor: key };
    });
  },

  select: (keys) => {
    set((state) => {
      const next = new Set(state.selected);
      let added = false;
      for (const key of keys) {
        if (!next.has(key)) {
          next.add(key);
          added = true;
        }
      }
      return added ? { selected: next } : state;
    });
  },

  seed: (key) => {
    set((state) =>
      state.selected.size > 0 ? state : { selected: new Set([key]), anchor: key },
    );
  },

  selectOnly: (keys) => {
    set(() => {
      const next = new Set(keys);
      let last: string | null = null;
      for (const key of next) last = key;
      return { selected: next, anchor: last };
    });
  },

  settleBatch: (batchKeys, retainKeys) => {
    set((state) => {
      const retain = new Set(retainKeys);
      // The batch's OWN keys that it is giving up (succeeded moves, or a key
      // that was already deselected by the user mid-batch — dropping an absent
      // key is a no-op either way).
      const removed = new Set<string>();
      for (const key of batchKeys) {
        if (!retain.has(key)) removed.add(key);
      }
      // Subtract-only: the retained (failed) keys are left exactly as the store
      // holds them, so a user who cleared or re-selected mid-batch keeps their
      // own state. In the uncontended case — the store still holds the batch's
      // selection — subtracting the succeeded keys leaves precisely the failed
      // ones selected, which is the R15 retry affordance.
      if (removed.size === 0) return state;
      const next = new Set<string>();
      let dropped = false;
      for (const key of state.selected) {
        if (removed.has(key)) {
          dropped = true;
          continue;
        }
        next.add(key);
      }
      const nextAnchor =
        state.anchor !== null && removed.has(state.anchor) ? null : state.anchor;
      if (!dropped && nextAnchor === state.anchor) return state;
      return { selected: next, anchor: nextAnchor };
    });
  },

  clear: () => {
    set((state) =>
      state.selected.size === 0 && state.anchor === null
        ? state
        : { selected: new Set<string>(), anchor: null },
    );
  },

  prune: (liveKeys) => {
    set((state) => {
      const nextSelected = pruneSelection(state.selected, liveKeys);
      // A stale anchor pointing at a vanished row would silently produce an
      // empty range on the next Shift-click; drop it with the row.
      const nextAnchor =
        state.anchor !== null && !liveKeys.has(state.anchor) ? null : state.anchor;
      if (nextSelected === state.selected && nextAnchor === state.anchor) return state;
      return { selected: nextSelected, anchor: nextAnchor };
    });
  },
}));
