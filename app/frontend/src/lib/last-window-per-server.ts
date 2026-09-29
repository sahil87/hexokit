import type { ProjectSession } from "@/types";

/**
 * Client-side per-server "last window the user viewed" memory, backing the
 * server-switch landing resolution: the three switch entry points (sidebar
 * tile, palette `Server: Switch to`, Host page tile) reopen the remembered
 * window instead of dropping on the session-tiles overview.
 *
 * Per-client only (Constitution II — no backend persistence); the `hexokit-*`
 * key family mirrors the other navigation/preference keys
 * (`hexokit-last-pinned-board`, `hexokit-open-last-used`). The stored value is
 * the canonical `@N` window id — the URL-segment `N` form is a router-codec
 * concern (`lib/router-url.ts`), never stored here. Reads/writes are
 * best-effort with the try/catch-noop pattern from `lib/window-view.ts` so
 * private mode / quota / SSR never throw.
 */
export const LAST_WINDOW_KEY_PREFIX = "hexokit-last-window:";

/** Per-server storage key: `hexokit-last-window:{server}`. */
export function lastWindowStorageKey(server: string): string {
  return `${LAST_WINDOW_KEY_PREFIX}${server}`;
}

/**
 * Read the window last viewed on `server`. Returns `null` when absent or when
 * localStorage is unavailable. The value is NOT validated here — validation
 * against the live snapshot is `resolveServerLandingWindow`'s job.
 */
export function readLastWindow(server: string): string | null {
  try {
    return localStorage.getItem(lastWindowStorageKey(server));
  } catch {
    return null;
  }
}

/**
 * Persist the window last viewed on `server`. Best-effort — a localStorage
 * failure (private mode / quota / SSR) is swallowed.
 */
export function writeLastWindow(server: string, windowId: string): void {
  try {
    localStorage.setItem(lastWindowStorageKey(server), windowId);
  } catch {
    /* noop — best-effort persistence */
  }
}

/**
 * Resolve which window a server switch should land on. Pure — no storage, no
 * navigation; `remembered` and the already-derived `sessionOrder` come from
 * the call site.
 *
 * Resolution order:
 * 1. The remembered window, when it is present in a non-empty live snapshot.
 * 2. The remembered window optimistically when the snapshot is EMPTY — only
 *    attached servers stream windows, so empty means "not yet known", not
 *    "no windows". A stale id self-heals: `SurfaceLayout`'s
 *    `onSessionNotFound` bounces to `/$server`.
 * 3. The first session in `sessionOrder` present in the snapshot, then its
 *    active window, falling back to its first window.
 * 4. `null` — show the session-tiles overview at bare `/$server`.
 */
export function resolveServerLandingWindow({
  sessions,
  sessionOrder,
  remembered,
}: {
  sessions: ProjectSession[];
  sessionOrder: string[];
  remembered: string | null;
}): string | null {
  if (remembered) {
    if (sessions.length === 0) return remembered;
    const stillLive = sessions.some((s) =>
      s.windows.some((w) => w.windowId === remembered),
    );
    if (stillLive) return remembered;
  }
  for (const name of sessionOrder) {
    const session = sessions.find((s) => s.name === name);
    if (!session) continue;
    const active = session.windows.find((w) => w.isActiveWindow);
    return (active ?? session.windows[0])?.windowId ?? null;
  }
  return null;
}
