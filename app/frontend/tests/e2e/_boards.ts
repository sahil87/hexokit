/**
 * Shared board-API helpers for e2e specs.
 *
 * Board specs seed state through `POST /api/boards/{board}/pin|/unpin`; before
 * this module each spec carried its own inline copy of that call (three call
 * styles: `page.request` relative, `request` fixture relative, and `request`
 * with a hand-built absolute base URL). These helpers centralize the calls so
 * a pin-API change lands in one place instead of ~20 sites.
 *
 * CLEANUP HAZARD: pinning creates a `_rk-pin-<id>` session that PERSISTS on
 * the long-lived `rk-test-e2e` tmux server across runs — killing the source
 * session does not reap it. Specs whose pins are not reaped by their own
 * unpin flow use the opt-in registry layer below (`trackPin` + `unpinAll` in
 * `afterAll`) so stale pin-sessions never pollute later runs.
 *
 * Layers:
 *  - Base API (`pinWindow` / `unpinWindow`) — ok-asserted, universal. Callers
 *    pass `page.request` or the `request` fixture; paths are relative because
 *    `playwright.config.ts` always sets `use.baseURL`, so both context kinds
 *    resolve them.
 *  - Cleanup registry (`trackPin` / `unpinAll`) — opt-in, for specs whose
 *    `afterAll` sweeps every pin made during the file. The registry is
 *    module-level state shared for the LIFE OF A WORKER PROCESS — Playwright
 *    reuses workers across spec files (same workerHash) and never clears the
 *    module cache — so every `trackPin` caller MUST sweep via `unpinAll` in
 *    its own `afterAll`, or its entries leak into the next file's sweep.
 *    No `pinTracked` combo is provided — call sites compose `pinWindow` +
 *    `trackPin` explicitly, keeping the layer boundary visible.
 *  - Verbatim fold-ins with the same home: `apiBase` (absolute-origin builder
 *    for specs asserting non-board endpoints against the raw `request`
 *    fixture) and `isTerminalsSocket` (the terminals-mux URL classifier used
 *    by WebSocket-counting board specs).
 */
import { expect, type APIRequestContext } from "@playwright/test";
import { harnessOrigin } from "./_harness";

/** A pinned-window identity, as sent to `/api/boards/{board}/pin|/unpin`. */
export interface PinEntry {
  board: string;
  server: string;
  windowId: string;
}

/** POST `/api/boards/{board}/pin` with ok-assert (message carries the
 *  windowId + response status). */
export async function pinWindow(
  request: APIRequestContext,
  board: string,
  server: string,
  windowId: string,
): Promise<void> {
  const res = await request.post(`/api/boards/${board}/pin`, {
    data: { server, windowId },
  });
  expect(res.ok(), `pin ${windowId} → ${res.status()}`).toBeTruthy();
}

/** POST `/api/boards/{board}/unpin` with ok-assert — for mid-test unpins that
 *  are themselves under test (or must not fail silently). `afterAll` cleanup
 *  goes through {@link unpinAll} instead. */
export async function unpinWindow(
  request: APIRequestContext,
  board: string,
  server: string,
  windowId: string,
): Promise<void> {
  const res = await request.post(`/api/boards/${board}/unpin`, {
    data: { server, windowId },
  });
  expect(res.ok(), `unpin ${windowId} → ${res.status()}`).toBeTruthy();
}

// ---- opt-in cleanup-registry layer (board-autofit-style specs) ----

const registry: PinEntry[] = [];

/** Record a pin for `afterAll` cleanup. The registry lives for the whole
 *  worker process (workers are reused across spec files), so every caller
 *  MUST sweep via {@link unpinAll} in its own `afterAll`.
 *  Entries carry `board` because one registry can span multiple boards. */
export function trackPin(entry: PinEntry): void {
  registry.push(entry);
}

/** Best-effort unpin of every tracked entry (try/catch per entry, no
 *  ok-assert — matching the per-file `afterAll` loops this replaces), then
 *  clears the registry. */
export async function unpinAll(request: APIRequestContext): Promise<void> {
  for (const entry of registry) {
    try {
      await request.post(`/api/boards/${entry.board}/unpin`, {
        data: { server: entry.server, windowId: entry.windowId },
      });
    } catch {
      // Best-effort — a dead server or already-gone pin must not mask the
      // test result.
    }
  }
  registry.length = 0;
}

// ---- verbatim-dupe fold-ins with the same home ----

/** Resolve the backend origin for raw `request`-fixture calls:
 *  `baseURL ?? harnessOrigin()` — the harness-only E2E_PORT read and its
 *  fail-closed sentinel fallback live in _harness.ts (never the ambient
 *  RK_PORT, which would silently target a live dev server). */
export function apiBase(baseURL: string | undefined): string {
  return baseURL ?? harnessOrigin();
}

/** True for the terminals mux URL (`/ws/terminals`) — one socket per tab
 *  carrying all pane streams. */
export function isTerminalsSocket(url: string): boolean {
  return /\/ws\/terminals(\?|$)/.test(url);
}
