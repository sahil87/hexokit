/**
 * Module-level, per-target draft store for the docked compose strip
 * (260718-dhdj; per-target keying + persistence 260801-cyth).
 *
 * Drafts are keyed by their SEND TARGET — `entryKey(server, windowId)` from
 * `@/store/window-store`, the same key the strip's `focusedKey()` computes — so
 * a draft stays with its addressee instead of traveling with the user across
 * routes or board pane-focus changes. The strip resolves the key from the live
 * focused target each render; with no target it is disabled and shows the
 * stable empty draft.
 *
 * The store lives at module scope (not component state) because the strip is
 * *mounted conditionally* in two separate footers (`app.tsx`'s AppShell and
 * `board-page.tsx`), gated on the `composeStripEnabled` chrome preference —
 * component-local `useState` would destroy unsent drafts on toggle-off and on
 * terminal↔board route changes. It is exposed through a `useSyncExternalStore`
 * seam — the same module-store pattern as the window-switch pending mask
 * (`window-transition.ts`): a module map + a listener set +
 * `getSnapshot`/`subscribe`, notify-only-on-change, with a STABLE snapshot
 * object per key while that key's draft is unchanged.
 *
 * Persistence: draft TEXT survives page refreshes via one localStorage key
 * (`hexokit-compose-drafts`, a JSON map `{[entryKey]: {text, updatedAt}}`),
 * written through synchronously on every commit and hydrated tolerantly at
 * module load (malformed content degrades to empty — the `parseOverrides`
 * posture from `keybindings.ts`). Writes prune: empty-text entries are never
 * stored, entries outside the `MAX_DRAFT_AGE_MS` window (stale — or
 * future-dated by clock skew) are dropped, and only the
 * `MAX_PERSISTED_DRAFTS` newest (by `updatedAt`) are kept — tmux window IDs
 * are reused after a server restart, so stale drafts must age out. Multi-tab
 * is last-write-wins (no `storage`-event sync).
 *
 * A second subscriber class shares the store: the desktop quake terminal's
 * compose (the drawer's docked strip and the top-bar launcher box) keys its
 * draft by the operator window target — `entryKey(server, operatorWindowId)`,
 * the same key the operator page's own strip uses, so the two views read one
 * draft. Quake drafts count toward the same cap and age out the same way.
 *
 * Attachments (`File` objects) cannot reach localStorage, so they stay
 * in-memory per key and die on refresh — a cosmetic loss: uploads are eager
 * (already on the target worktree's disk) and their path lines live in the
 * persisted text, so sending still works after a reload. Blob URLs for
 * previews are derived per-mount from the retained `File` objects.
 *
 * SENT-HISTORY (260806-kadm) — a second, independent per-target map living in
 * this same module (so the `entryKey` coupling and the persistence discipline
 * stay in one place). Sending clears the draft unconditionally and delivery is
 * unverifiable at all three hops (queued `ws.send`, an ignored PTY write error,
 * a pane app that swallows the bytes), so every transmitted text is recorded
 * here and the strip's ↑ walks back through it. Recovery over verification.
 *
 * It rides a SIBLING localStorage key (`hexokit-compose-sent-history`) rather
 * than folding into the draft schema: the shipped draft parser and prune
 * pipeline stay byte-compatible, and neither surface's corruption can take the
 * other down. Same posture otherwise — write-through on every push, tolerant
 * parse at module load, and the same age/cap pruning (window IDs are reused
 * after a tmux server restart, so stale history must not resurrect against a
 * stranger window).
 */

/** A pending attachment: its uploaded path (a line in the textarea) plus the
 * retained `File` object (kept client-side in memory for previews). */
export type ComposeAttachment = {
  path: string;
  file: File;
};

/** One target's compose draft: the textarea text and pending attachments. */
export type ComposeDraft = {
  text: string;
  attachments: ComposeAttachment[];
};

/** localStorage key holding the persisted draft-text map. */
export const COMPOSE_DRAFTS_STORAGE_KEY = "hexokit-compose-drafts";

/** Persist at most this many drafts (newest by `updatedAt` win). */
export const MAX_PERSISTED_DRAFTS = 30;

/** Drafts untouched for longer than this are dropped (tmux window IDs are
 * reused after a server restart, so old drafts can point at strangers). */
export const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const EMPTY_ATTACHMENTS: ComposeAttachment[] = [];

/** The stable empty draft returned for null/absent keys — a single frozen
 * identity so `useSyncExternalStore` never sees a fresh object for "nothing". */
const EMPTY_DRAFT: ComposeDraft = { text: "", attachments: EMPTY_ATTACHMENTS };

type DraftEntry = {
  text: string;
  attachments: ComposeAttachment[];
  updatedAt: number;
};

// Live drafts keyed by `entryKey(server, windowId)`, plus a parallel cache of
// snapshot objects so `getComposeDraft(key)` returns a STABLE reference while
// that key's draft is unchanged — `useSyncExternalStore` compares snapshots by
// identity and would loop forever on a fresh object every call.
let drafts = new Map<string, DraftEntry>();
let snapshots = new Map<string, ComposeDraft>();

const listeners = new Set<() => void>();

/** Snapshot for `useSyncExternalStore`. Stable identity per key while that
 * key's draft is unchanged; the stable empty draft for null/absent keys. */
export function getComposeDraft(key: string | null): ComposeDraft {
  if (key === null) return EMPTY_DRAFT;
  return snapshots.get(key) ?? EMPTY_DRAFT;
}

/**
 * Subscribe to draft changes (the `useSyncExternalStore` contract). One global
 * listener set — any key's commit notifies (at most one strip is mounted, so
 * per-key channels would buy nothing). Returns an unsubscribe function.
 */
export function subscribeComposeDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** The age + cap prune both persisted maps share: drop entries the caller
 * deems empty and entries outside the age window, then keep only the `cap`
 * newest by `updatedAt`. The age check is two-sided (`Math.abs`) so a
 * future-dated `updatedAt` (clock skew, corrupted storage) ages out like any
 * other entry instead of sorting first and squatting the cap forever. */
function pruneByAgeAndCap<T extends { updatedAt: number }>(
  entries: [string, T][],
  isEmpty: (entry: T) => boolean,
  cap: number,
): [string, T][] {
  const now = Date.now();
  return entries
    .filter(([, e]) => !isEmpty(e) && Math.abs(now - e.updatedAt) <= MAX_DRAFT_AGE_MS)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, cap);
}

/** The one prune pipeline shared by draft write-through and hydration. */
function pruneDraftEntries<T extends { text: string; updatedAt: number }>(
  entries: [string, T][],
): [string, T][] {
  return pruneByAgeAndCap(entries, (e) => e.text === "", MAX_PERSISTED_DRAFTS);
}

/** Best-effort write-through: serialize non-empty drafts (text only — `File`s
 * cannot be stored), pruned by age and capped to the newest. */
function persist(): void {
  try {
    const entries = pruneDraftEntries([...drafts.entries()]);
    if (entries.length === 0) {
      localStorage.removeItem(COMPOSE_DRAFTS_STORAGE_KEY);
    } else {
      const stored = Object.fromEntries(
        entries.map(([key, e]) => [key, { text: e.text, updatedAt: e.updatedAt }]),
      );
      localStorage.setItem(COMPOSE_DRAFTS_STORAGE_KEY, JSON.stringify(stored));
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

/** Rebuild the key's cached snapshot (dropping fully-empty entries), persist,
 * and notify subscribers. */
function commit(key: string): void {
  const entry = drafts.get(key);
  if (entry && (entry.text !== "" || entry.attachments.length > 0)) {
    snapshots.set(key, { text: entry.text, attachments: entry.attachments });
  } else {
    drafts.delete(key);
    snapshots.delete(key);
  }
  persist();
  notify();
}

/** Set a target's draft text. Accepts a value or an updater (mirrors React's
 * setter). No-op (no notify, no persist) when the text is unchanged. */
export function setComposeText(key: string, next: string | ((prev: string) => string)): void {
  const entry = drafts.get(key);
  const prev = entry?.text ?? "";
  const value = typeof next === "function" ? next(prev) : next;
  if (value === prev) return;
  drafts.set(key, {
    text: value,
    attachments: entry?.attachments ?? EMPTY_ATTACHMENTS,
    updatedAt: Date.now(),
  });
  commit(key);
}

/** Set a target's pending attachments. Accepts a value or an updater. */
export function setComposeAttachments(
  key: string,
  next: ComposeAttachment[] | ((prev: ComposeAttachment[]) => ComposeAttachment[]),
): void {
  const entry = drafts.get(key);
  const prev = entry?.attachments ?? EMPTY_ATTACHMENTS;
  const value = typeof next === "function" ? next(prev) : next;
  if (value === prev) return;
  drafts.set(key, { text: entry?.text ?? "", attachments: value, updatedAt: Date.now() });
  commit(key);
}

/** Clear ONE target's draft (text + attachments) after a delivered send.
 * Other targets' drafts are untouched. No-op (no notify) when the key holds
 * no draft, so a redundant clear does not churn. */
export function clearComposeDraft(key: string): void {
  if (!drafts.has(key)) return;
  drafts.delete(key);
  commit(key);
}

function isStoredDraft(value: unknown): value is { text: string; updatedAt: number } {
  if (typeof value !== "object" || value === null) return false;
  const { text, updatedAt } = value as { text?: unknown; updatedAt?: unknown };
  return typeof text === "string" && typeof updatedAt === "number" && Number.isFinite(updatedAt);
}

/**
 * (Re)seed the in-memory map from localStorage, replacing all live drafts
 * (attachments included — they are in-memory only and cannot be restored).
 * Tolerant parse: malformed JSON, non-object roots, and wrong-typed entries
 * degrade to empty/skipped. Applies the same pruning as writes (drop empty,
 * drop stale, cap to the newest). Called once at module load; tests reset the
 * store by clearing localStorage and calling this again.
 */
export function hydrateComposeDrafts(): void {
  drafts = new Map();
  snapshots = new Map();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(COMPOSE_DRAFTS_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const restored = pruneDraftEntries(
        Object.entries(parsed).filter(
          (pair): pair is [string, { text: string; updatedAt: number }] => isStoredDraft(pair[1]),
        ),
      );
      for (const [key, v] of restored) {
        drafts.set(key, { text: v.text, attachments: EMPTY_ATTACHMENTS, updatedAt: v.updatedAt });
        snapshots.set(key, { text: v.text, attachments: EMPTY_ATTACHMENTS });
      }
    }
  }
  notify();
}

hydrateComposeDrafts();

// ── sent history (260806-kadm) ───────────────────────────────────────────────

/** localStorage key holding the persisted sent-history map — a SIBLING of
 * `COMPOSE_DRAFTS_STORAGE_KEY`, never folded into it (see the module header). */
export const COMPOSE_SENT_HISTORY_STORAGE_KEY = "hexokit-compose-sent-history";

/** Max recallable sent entries kept per target (newest first). */
export const MAX_SENT_HISTORY_PER_TARGET = 10;

/** Persist history for at most this many targets (newest by `updatedAt` win).
 * A sibling of `MAX_PERSISTED_DRAFTS` rather than a reuse, so the two surfaces
 * can diverge without a rename. */
export const MAX_PERSISTED_SENT_HISTORIES = 30;

/** The stable empty history returned for null/absent keys — a single frozen
 * identity so a caller can compare by reference. */
const EMPTY_SENT_HISTORY: readonly string[] = Object.freeze([]);

type SentHistoryEntry = {
  /** Newest first. */
  entries: string[];
  updatedAt: number;
};

let sentHistories = new Map<string, SentHistoryEntry>();

function pruneSentHistories(
  entries: [string, SentHistoryEntry][],
): [string, SentHistoryEntry][] {
  return pruneByAgeAndCap(
    entries,
    (e) => e.entries.length === 0,
    MAX_PERSISTED_SENT_HISTORIES,
  );
}

/** Best-effort write-through for the sent-history map, pruned by age and
 * capped to the newest targets. Mirrors `persist()`. */
function persistSentHistory(): void {
  try {
    const entries = pruneSentHistories([...sentHistories.entries()]);
    if (entries.length === 0) {
      localStorage.removeItem(COMPOSE_SENT_HISTORY_STORAGE_KEY);
    } else {
      const stored = Object.fromEntries(
        entries.map(([key, e]) => [key, { entries: e.entries, updatedAt: e.updatedAt }]),
      );
      localStorage.setItem(COMPOSE_SENT_HISTORY_STORAGE_KEY, JSON.stringify(stored));
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

/**
 * Push a sent text onto a target's history (called by the strip's `send()`,
 * all three modes, immediately BEFORE `clearComposeDraft`). Newest first.
 *
 * No-ops on whitespace-only text (the empty-submit bare `\r` pushes nothing),
 * and on text identical to the current newest entry — re-sending the same text
 * (the natural retry after a swallowed send) must not burn a slot. The STORED
 * value is the exact untrimmed text: recall must reproduce what was
 * transmitted, and only the push GUARD trims.
 *
 * History is not part of the `useSyncExternalStore` seam — recall reads at
 * keydown time, so a push notifies no subscriber.
 */
export function pushComposeSentHistory(key: string, text: string): void {
  if (text.trim() === "") return;
  const existing = sentHistories.get(key);
  const prev = existing?.entries ?? [];
  if (prev[0] === text) return;
  sentHistories.set(key, {
    entries: [text, ...prev].slice(0, MAX_SENT_HISTORY_PER_TARGET),
    updatedAt: Date.now(),
  });
  persistSentHistory();
}

/** Newest-first sent texts for a target; the stable empty array for
 * null/absent keys. A plain read — every mutation replaces the array rather
 * than mutating in place, so the returned reference never tears. */
export function getComposeSentHistory(key: string | null): readonly string[] {
  if (key === null) return EMPTY_SENT_HISTORY;
  return sentHistories.get(key)?.entries ?? EMPTY_SENT_HISTORY;
}

function isStoredSentHistory(value: unknown): value is SentHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const { entries, updatedAt } = value as { entries?: unknown; updatedAt?: unknown };
  if (!Array.isArray(entries) || !entries.every((e) => typeof e === "string")) return false;
  return typeof updatedAt === "number" && Number.isFinite(updatedAt);
}

/**
 * (Re)seed the in-memory sent-history map from localStorage. Tolerant parse:
 * malformed JSON, non-object roots, and wrong-typed entries degrade to
 * empty/skipped (the `hydrateComposeDrafts` posture). Applies the same pruning
 * as writes and re-caps each target's entries. Called once at module load;
 * tests reset by clearing localStorage and calling this again.
 */
export function hydrateComposeSentHistory(): void {
  sentHistories = new Map();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(COMPOSE_SENT_HISTORY_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const restored = pruneSentHistories(
    Object.entries(parsed).filter((pair): pair is [string, SentHistoryEntry] =>
      isStoredSentHistory(pair[1]),
    ),
  );
  for (const [key, v] of restored) {
    sentHistories.set(key, {
      entries: v.entries.slice(0, MAX_SENT_HISTORY_PER_TARGET),
      updatedAt: v.updatedAt,
    });
  }
}

hydrateComposeSentHistory();
