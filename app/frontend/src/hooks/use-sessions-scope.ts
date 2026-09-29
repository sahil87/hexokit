import { useLocalStorageEnum } from "./use-local-storage-enum";

/** localStorage key for the sidebar sessions-pane scope. Deliberately NOT
 *  migrated from the old `hexokit-panel-server` coupling — that key encodes
 *  the SERVER panel's own collapse state, not scope intent. */
export const SESSIONS_SCOPE_KEY = "hexokit-panel-sessions-scope";

export const SESSIONS_SCOPES = ["all", "current"] as const;

/** Which servers' session groups the sidebar's SESSIONS pane lists:
 *  `all` (default) — every server; `current` — the resolved current server
 *  only, falling back to all when no current server resolves. */
export type SessionsScope = (typeof SESSIONS_SCOPES)[number];

/**
 * Persisted sessions-pane scope, shared reactively across the SESSIONS-header
 * chip, the session list, and the command-palette entry (sibling subscribers
 * via the enum hook's in-module pub/sub). Unrecognized stored values read as
 * `all`.
 */
export function useSessionsScope(): [SessionsScope, (next: SessionsScope) => void] {
  return useLocalStorageEnum<SessionsScope>(SESSIONS_SCOPE_KEY, "all", SESSIONS_SCOPES);
}
