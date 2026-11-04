import { deduplicatedFetch, throwOnError } from "./client";

/** Pane info aggregated from list-panes for an entry's window. Mirrors the backend's PaneInfo. */
export interface BoardPaneInfo {
  paneId: string;
  paneIndex: number;
  cwd: string;
  command: string;
  isActive: boolean;
  gitBranch?: string;
}

/**
 * Board summary (list view). Returned in display order: boards present in the
 * stored order (`~/.config/hexokit/config.yaml` `board_order:`) first, ranked by their
 * index, then any unranked boards alphabetically by `name`.
 */
export interface BoardSummary {
  name: string;
  pinCount: number;
}

/**
 * A single pinned-window entry on a board, joined with live window data for
 * rendering. In the move-based model the pinned window has been MOVED into its
 * own single-window pin-session (`_rk-pin-<id>`) server-side, so `session` is
 * that pin-session — the relay resolves it from `windowId` transparently, and
 * the component does not need to know it is a pin-session.
 */
export interface BoardEntry {
  server: string;
  windowId: string;
  session: string;
  windowIndex: number;
  windowName: string;
  orderKey: string;
  panes?: BoardPaneInfo[];
}

/** Response from POST /api/boards/{name}/reorder. */
export interface ReorderResponse {
  ok: true;
  newOrderKey: string;
}

/**
 * GET /api/boards — derived from `_rk-pin-*` pin-sessions grouped by their
 * `@rk_ses_pin_board` session var, summarized across reachable servers and sorted by
 * name. Boards are server-scoped (a pinned window's session lives on one tmux
 * server); a board exists only while at least one pin carries its name.
 */
export async function listBoards(): Promise<BoardSummary[]> {
  const res = await deduplicatedFetch("/api/boards");
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** GET /api/boards/{name} — entries for a single board, sorted by orderKey. */
export async function getBoard(name: string): Promise<BoardEntry[]> {
  const res = await deduplicatedFetch(`/api/boards/${encodeURIComponent(name)}`);
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * POST /api/boards/{name}/pin — pin a window on a specific server to the
 * named board. `server` is the FIRST positional arg per the project's
 * server-routing contract; it travels in the JSON body, not the query.
 */
export async function pinWindow(
  server: string,
  windowId: string,
  board: string,
): Promise<{ ok: true }> {
  const res = await fetch(`/api/boards/${encodeURIComponent(board)}/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server, windowId }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** POST /api/boards/{name}/unpin — symmetric with pinWindow. */
export async function unpinWindow(
  server: string,
  windowId: string,
  board: string,
): Promise<{ ok: true }> {
  const res = await fetch(`/api/boards/${encodeURIComponent(board)}/unpin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server, windowId }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * POST /api/settings — persist the user-defined board display order as the
 * `board_order` settings key (partial merge per Constitution IX). The client
 * sends the FULL ordered list of board names (rank = index); the backend
 * writes it to ~/.config/hexokit/config.yaml and broadcasts a server-global
 * `board-order` SSE event so every client re-sorts live. Mirrors
 * `setServerOrder`.
 */
export async function setBoardOrder(order: string[]): Promise<{ ok: true }> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ board_order: order }),
  });
  if (!res.ok) await throwOnError(res);
  return { ok: true };
}

/**
 * POST /api/boards/{name}/reorder — server computes the new order key via
 * fractional indexing. `before` and `after` are sibling windowIds on the
 * board (or null for prepend/append).
 */
export async function reorderPin(
  server: string,
  windowId: string,
  board: string,
  before: string | null,
  after: string | null,
): Promise<ReorderResponse> {
  // `before`/`after` are sent as JSON `null` for prepend/append per the
  // documented API contract. The backend accepts both `null` and `""` for
  // backward compatibility, but `null` is the canonical wire form.
  const res = await fetch(`/api/boards/${encodeURIComponent(board)}/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      server,
      windowId,
      before,
      after,
    }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}
