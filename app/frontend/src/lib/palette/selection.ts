/**
 * Pure builders for the command-palette SELECTION command family (260807-nf9f):
 * `Selection: Select all merged (N)`, bulk close/send, and one
 * `Selection: Move N window(s) to <session>` entry per eligible target session.
 *
 * Follows the lib/palette/pin.ts / lib/palette/move.ts pattern (pure,
 * dependency-free, unit-testable) so the label composition, merged derivation,
 * and eligibility gating are verifiable without mounting the shell. The action
 * bodies are thin callbacks passed in by the caller (app.tsx wires them to the
 * selection store, compose target, and sequential batch executors).
 *
 * The bulk move is gated to a SINGLE server: tmux cannot move a window across
 * tmux servers (the sidebar's drag-and-drop path already rejects cross-server
 * drops), so a cross-server selection is offered no move targets at all. The
 * palette's own fuzzy filter IS the session picker — there is deliberately no
 * picker dialog and no create-if-missing entry (Constitution IV).
 */
import type { PaletteAction } from "@/components/command-palette";
import {
  selectionKey,
  singleSelectedServer,
  splitSelectionKey,
} from "@/lib/selection";

/** Stable id for the select-all-merged entry — callers/tests reference it. */
export const SELECT_ALL_MERGED_ACTION_ID = "selection-select-all-merged";

/** Id prefix for the per-target-session move entries. */
export const SELECTION_MOVE_ACTION_PREFIX = "selection-move-to-";

/** Stable ids for the cross-server-capable bulk actions. */
export const SELECTION_CLOSE_ACTION_ID = "selection-close";
export const SELECTION_SEND_PROMPT_ACTION_ID = "selection-send-prompt";

/**
 * The selection gestures, rendered as the palette entries' `shortcut` badge.
 *
 * The project review rule requires new keyboard shortcuts to be documented at
 * the palette registration, and the `x` row-toggle is otherwise INVISIBLE: it
 * is a bare key handled inside the sidebar tree's own keydown (deliberately not
 * a global chord in `DEFAULT_BINDINGS`, which would hijack `x` app-wide), so it
 * appears on no chord map and in no shortcuts overlay. Hanging it off the
 * selection entries — the only palette rows that exist because of the feature —
 * is the discovery surface. Cmd-click/Shift-click ride along since they are the
 * same gesture family and equally undocumented elsewhere.
 */
export const SELECTION_GESTURE_HINT = "x · ⌘-click · ⇧-click";

/** The minimum a window must expose for merged-selection derivation. */
export type SelectableWindow = {
  windowId: string;
  prState?: "open" | "merged" | "closed";
};

/** The minimum a session must expose for the builders. */
export type SelectableSession = {
  name: string;
  windows: SelectableWindow[];
};

/** `N tab` / `N tabs` — the labels carry the live count. */
function tabCount(n: number): string {
  return `${n} ${n === 1 ? "tab" : "tabs"}`;
}

/** `N agent` / `N agents` — prompt labels carry the live count. */
function agentCount(n: number): string {
  return `${n} ${n === 1 ? "agent" : "agents"}`;
}

/**
 * Build the destructive bulk-close action. Unlike move, close is eligible for
 * cross-server selections: every request derives its own server from the
 * composite key. The optional `confirmLabel` is interpreted by CommandPalette
 * as its one-entry confirmation sub-step.
 */
export function buildSelectionCloseAction(
  selectedKeys: ReadonlySet<string>,
  onClose: (keys: string[]) => void,
): PaletteAction | null {
  if (selectedKeys.size === 0) return null;
  const keys = [...selectedKeys];
  const count = tabCount(keys.length);
  return {
    id: SELECTION_CLOSE_ACTION_ID,
    label: `Selection: Close ${count}`,
    confirmLabel: `Close ${count} — Enter to confirm`,
    onSelect: () => onClose(keys),
  };
}

/**
 * Build the selection-broadcast action. Its callback receives a snapshot of
 * the selected composite keys so the compose target's count and eventual
 * recipients cannot drift while the user types. Cross-server selections are
 * valid because window-send, like close, carries a per-request server.
 */
export function buildSelectionSendPromptAction(
  selectedKeys: ReadonlySet<string>,
  onCompose: (keys: string[]) => void,
): PaletteAction | null {
  if (selectedKeys.size === 0) return null;
  const keys = [...selectedKeys];
  return {
    id: SELECTION_SEND_PROMPT_ACTION_ID,
    label: `Selection: Send prompt to ${agentCount(keys.length)}`,
    onSelect: () => onCompose(keys),
  };
}

export type SelectionBatchResult = {
  failedKeys: string[];
  firstError: string;
};

/**
 * Run one operation per composite selection key, strictly sequentially and
 * continue-on-error. Close and send share this control-flow contract while
 * keeping their operation-specific API calls and toast copy in app.tsx.
 */
export async function executeSelectionBatch(
  keys: readonly string[],
  operation: (target: { server: string; windowId: string }) => Promise<unknown>,
): Promise<SelectionBatchResult> {
  const failedKeys: string[] = [];
  let firstError = "";
  for (const key of keys) {
    const target = splitSelectionKey(key);
    if (!target) {
      failedKeys.push(key);
      if (!firstError) firstError = "malformed tab key";
      continue;
    }
    try {
      await operation(target);
    } catch (error) {
      failedKeys.push(key);
      if (!firstError) {
        firstError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return { failedKeys, firstError };
}

/** Operation-specific copy for `batchToast` — the shared aggregate report. */
export type BatchToastCopy = {
  /** Verb phrase opening the all-succeeded message (`Closed`, `Sent prompt to`). */
  success: string;
  /** Verb phrase opening the partial/total-failure message (`Sent to`). */
  failure: string;
  /** Singular item noun, pluralized on the batch TOTAL (`window`, `agent`). */
  noun: string;
  /** Optional trailing qualifier, e.g. ` to <session>` for the bulk move. */
  qualifier?: string;
};

/**
 * Compose the ONE aggregate toast a selection batch reports — every batch says
 * `<verb> N <noun>` on full success and
 * `<verb> X of N <noun> — F failed: <first error>` on partial or total failure.
 * The shape is identical for move/close/send, so only the verb/noun/qualifier
 * copy lives at the call sites; `failed` picks the toast variant there.
 */
export function batchToast(
  copy: BatchToastCopy,
  total: number,
  { failedKeys, firstError }: SelectionBatchResult,
): { message: string; failed: boolean } {
  const done = total - failedKeys.length;
  const noun = total === 1 ? copy.noun : `${copy.noun}s`;
  const qualifier = copy.qualifier ?? "";
  if (failedKeys.length === 0) {
    return { message: `${copy.success} ${done} ${noun}${qualifier}`, failed: false };
  }
  return {
    message: `${copy.failure} ${done} of ${total} ${noun}${qualifier} — ${failedKeys.length} failed: ${firstError}`,
    failed: true,
  };
}

/**
 * The composite selection keys of every merged-PR window on `server`.
 *
 * Merged state comes from the PR knowledge the frontend already has: a window's
 * `prState === "merged"` (the same field `prGlyphColor` reads for its merged
 * branch). Reading the field directly keeps this module dependency-free.
 */
export function mergedWindowKeys(
  server: string,
  sessions: readonly SelectableSession[],
): string[] {
  const keys: string[] = [];
  for (const session of sessions) {
    for (const win of session.windows) {
      if (win.prState === "merged" && win.windowId !== "") {
        keys.push(selectionKey(server, win.windowId));
      }
    }
  }
  return keys;
}

/**
 * Build the `Selection: Select all merged (N)` action, or `null` when it should
 * be OMITTED (the palette family's convention — omit, never disable): no
 * current-server context, or that server has no merged windows. Scoped to the
 * current server only — a cross-server selection would dead-end the
 * single-server bulk move that is the whole point of the one-keystroke flow.
 */
export function buildSelectAllMergedAction(
  server: string | null,
  sessions: readonly SelectableSession[],
  onSelectAll: (keys: string[]) => void,
): PaletteAction | null {
  if (!server) return null;
  const keys = mergedWindowKeys(server, sessions);
  if (keys.length === 0) return null;
  return {
    id: SELECT_ALL_MERGED_ACTION_ID,
    label: `Selection: Select all merged (${keys.length})`,
    // Documents the otherwise-invisible row-selection gestures — see
    // SELECTION_GESTURE_HINT.
    shortcut: SELECTION_GESTURE_HINT,
    onSelect: () => onSelectAll(keys),
  };
}

/**
 * Build one `Selection: Move N window(s) to <session>` action per eligible
 * existing session on the selection's server — mirroring `buildPinActions`'
 * per-board entries rather than a bespoke picker dialog.
 *
 * Returns `[]` when the selection is empty or spans more than one server
 * (`singleSelectedServer` is the gate). A target whose move would be a COMPLETE
 * no-op — every selected window already lives in it — is excluded.
 *
 * The move target list and the move itself BOTH belong to the selection's
 * server, which is NOT necessarily the route server: with sessions scope "all"
 * the sidebar paints every server's groups, so a user can select rows on server
 * A while routed to server B. `sessionsServer` names whose sessions the caller
 * passed, and a mismatch against the selection's own server returns `[]`. That
 * guard is load-bearing rather than defensive bookkeeping: tmux window ids
 * (`@N`) are unique per SERVER only, so without it a caller handing over the
 * wrong server's list would silently produce plausible-looking targets keyed on
 * colliding ids — the exact defect this parameter closes.
 *
 * @param sessionsServer  the server `sessions` belongs to
 * @param sessions        that server's sessions, in display order (the entry order)
 * @param selectedKeys    the current selection (composite `${server}:${windowId}` keys)
 * @param onMove          invoked with the chosen target session name
 */
export function buildSelectionMoveActions(
  sessionsServer: string,
  sessions: readonly SelectableSession[],
  selectedKeys: ReadonlySet<string>,
  onMove: (targetSession: string) => void,
): PaletteAction[] {
  const server = singleSelectedServer(selectedKeys);
  if (server === null) return [];
  // The caller handed us a different server's sessions — offer nothing rather
  // than match `@N` ids across servers where they do not mean the same window.
  if (server !== sessionsServer) return [];

  // Which sessions do the selected windows currently live in? A target holding
  // ALL of them is a complete no-op and is excluded.
  const sessionOfKey = new Map<string, string>();
  for (const session of sessions) {
    for (const win of session.windows) {
      sessionOfKey.set(selectionKey(server, win.windowId), session.name);
    }
  }
  const homeSessions = new Set<string>();
  let resolvedCount = 0;
  for (const key of selectedKeys) {
    const home = sessionOfKey.get(key);
    if (home !== undefined) {
      homeSessions.add(home);
      resolvedCount++;
    }
  }
  // Every selected window resolves to the same single session ⇒ that session is
  // the complete no-op target. A selection with unresolved keys (a row that has
  // since left the tree) excludes nothing — the move is still meaningful.
  const noOpTarget =
    resolvedCount === selectedKeys.size && homeSessions.size === 1
      ? [...homeSessions][0]
      : null;

  const count = tabCount(selectedKeys.size);
  return sessions
    .filter((s) => s.name !== noOpTarget)
    .map((s) => ({
      id: `${SELECTION_MOVE_ACTION_PREFIX}${s.name}`,
      label: `Selection: Move ${count} to ${s.name}`,
      onSelect: () => onMove(s.name),
    }));
}
