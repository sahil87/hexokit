/**
 * One-shot localStorage key migration for the HexoKit rename: every
 * per-viewer preference moved from the `runkit-`/`runkit:` prefix to
 * `hexokit-`/`hexokit:`. Runs once per origin at boot (from `main.tsx`,
 * before the React tree mounts), guarded by a marker key — many prefs delete
 * their key to mean "default", so an unguarded re-run would resurrect values
 * the app deliberately dropped.
 *
 * Read-old/write-new: legacy keys are COPIES, never moves — the `runkit-*`
 * originals stay in place for one release so a downgrade keeps working.
 *
 * Retired-key translators are EXCLUDED from the copy and keep reading their
 * legacy names directly (their owners delete the legacy key after translating
 * it, so a copied counterpart would be dead weight nothing reads):
 * `runkit-window-view:` / `runkit-window-panel:` (`lib/window-view.ts`,
 * `lib/right-panel.ts` — translate into `@rk_win_layout`), `runkit-code-folder:`
 * (`app.tsx` — translates into `@rk_win_code_root`), the exact
 * `runkit-panel-sessions` key (`components/sidebar/index.tsx` — translates into
 * the per-server `hexokit-panel-sessions-{server}`), and
 * `runkit-operator-console-*` (`lib/quake-terminal.ts` — fallback read for the
 * quake drawer geometry/opacity).
 *
 * Everything is wrapped in try/catch: blocked or throwing storage (private
 * mode, sandboxed iframe) must never break app boot.
 */

/** Presence marker: when set, the copy has already run for this origin. */
export const STORAGE_MIGRATION_MARKER_KEY = "hexokit-storage-migrated";

const LEGACY_PREFIX = "runkit";
const LEGACY_PREFIXES = ["runkit-", "runkit:"] as const;
const NEW_PREFIX = "hexokit";

/** Retired key prefixes whose readers stay on the legacy names. */
const RETIRED_KEY_PREFIXES = [
  "runkit-window-view:",
  "runkit-window-panel:",
  "runkit-code-folder:",
  "runkit-operator-console-",
] as const;

/** Retired exact keys (live siblings share the stem, so no prefix match). */
const RETIRED_KEYS = new Set(["runkit-panel-sessions"]);

function isRetiredKey(key: string): boolean {
  return RETIRED_KEYS.has(key) || RETIRED_KEY_PREFIXES.some((p) => key.startsWith(p));
}

function isLegacyKey(key: string): boolean {
  return LEGACY_PREFIXES.some((p) => key.startsWith(p)) && !isRetiredKey(key);
}

/** The `hexokit` counterpart of a legacy key (`runkit-x` → `hexokit-x`). */
export function migratedKeyName(legacyKey: string): string {
  return NEW_PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
}

/**
 * Copy every live `runkit-*`/`runkit:*` key to its `hexokit` counterpart when
 * that counterpart is absent, then set the marker. No-op when the marker is
 * present or storage is unavailable/throwing. Never deletes legacy keys.
 *
 * The storage object is injectable for tests; production passes nothing and
 * gets the origin's `localStorage`.
 */
export function migrateLegacyStorageKeys(storage?: Storage): void {
  try {
    const store = storage ?? globalThis.localStorage;
    if (store == null) return;
    if (store.getItem(STORAGE_MIGRATION_MARKER_KEY) != null) return;
    // Snapshot the key list first: setItem below mutates the store, and a
    // live `key(i)` enumeration may skip or revisit entries under mutation.
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key != null && isLegacyKey(key)) keys.push(key);
    }
    for (const key of keys) {
      const newKey = migratedKeyName(key);
      if (store.getItem(newKey) != null) continue;
      const value = store.getItem(key);
      if (value != null) store.setItem(newKey, value);
    }
    store.setItem(STORAGE_MIGRATION_MARKER_KEY, "1");
  } catch {
    // localStorage unavailable (privacy mode, sandboxed iframe) — boot on.
  }
}
