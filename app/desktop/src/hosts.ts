/**
 * Host-list store: `<userData>/hosts.json` (schema version 1). A "host" is an
 * rk instance the shell can connect to — "server" is reserved for tmux
 * servers (the web UI's terminology).
 *
 * Deliberately electron-free — the data directory is a parameter (main.ts
 * passes `app.getPath('userData')`), which keeps this module unit-testable
 * under plain `node --test`. No electron-store: the file is small, writes are
 * tmp-file-then-rename (atomic on POSIX), and a corrupt or missing file
 * recovers as an empty list (startup then routes to the welcome page).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HostEntry {
  id: string;
  name: string;
  url: string;
  /** Last-visited SPA route remainder (`pathname + search`), when known. */
  lastPath?: string;
  /**
   * `rk remote` name for SSH-only hosts (additive, schema stays version 1).
   * Present when the host is reached through an ssh tunnel: `url` is still
   * the required, real, stable local origin (http://127.0.0.1:<port>), and
   * activating the host re-runs `rk remote connect <remote>` to heal the
   * tunnel. Older shells ignore the field and show the normal dead-host
   * state when the tunnel is down — acceptable degradation, no v2 bump.
   */
  remote?: string;
  /**
   * The host's instance accent color (`#…` hex as reported by the SPA's
   * `theme-color` meta via `did-change-theme-color`), persisted so the
   * host-switcher's edge bar survives cold start. Additive optional field
   * like `lastPath` — the schema stays version 1.
   */
  accentColor?: string;
}

export interface HostList {
  version: 1;
  activeId: string | null;
  hosts: HostEntry[];
}

export type NormalizeResult =
  | { ok: true; origin: string }
  | { ok: false; error: string };

export type AddResult =
  | { ok: true; list: HostList; host: HostEntry }
  | { ok: false; error: string };

const FILE_NAME = "hosts.json";

export function emptyList(): HostList {
  return { version: 1, activeId: null, hosts: [] };
}

/**
 * Normalize user input to a bare origin (`http://host:port`). Only http/https
 * are accepted — anything else (ftp:, file:, garbage) is a validation error
 * and is never persisted.
 */
export function normalizeOrigin(input: string): NormalizeResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: "Not a valid URL — include the scheme, e.g. http://host:6123" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `Unsupported scheme "${url.protocol}" — only http and https work` };
  }
  return { ok: true, origin: url.origin };
}

/**
 * Parse one stored entry. The required fields (id/name/url) must be strings —
 * anything else rejects the entry (and, via parseHostList, the file). The
 * optional `lastPath`, `remote`, and `accentColor` are tolerant: absent →
 * fine, string → kept, any other type → the field is dropped but the entry
 * (and file) still loads.
 */
function parseHostEntry(value: unknown): HostEntry | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("id" in value) || !("name" in value) || !("url" in value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.url !== "string"
  ) {
    return null;
  }
  const entry: HostEntry = { id: value.id, name: value.name, url: value.url };
  if ("lastPath" in value && typeof value.lastPath === "string") {
    entry.lastPath = value.lastPath;
  }
  if ("remote" in value && typeof value.remote === "string") {
    entry.remote = value.remote;
  }
  if ("accentColor" in value && typeof value.accentColor === "string") {
    entry.accentColor = value.accentColor;
  }
  return entry;
}

function parseHostList(value: unknown): HostList | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("version" in value) || !("activeId" in value) || !("hosts" in value)) return null;
  if (value.version !== 1) return null;
  if (value.activeId !== null && typeof value.activeId !== "string") return null;
  if (!Array.isArray(value.hosts)) return null;
  const hosts: HostEntry[] = [];
  for (const raw of value.hosts) {
    const entry = parseHostEntry(raw);
    if (entry === null) return null;
    hosts.push(entry);
  }
  return { version: 1, activeId: value.activeId, hosts };
}

/**
 * Load the list; a missing, unreadable, corrupt, or wrong-shape file is an
 * empty list. There is deliberately NO fallback read of the pre-rename
 * `servers.json` — no migration; that file is never read, never deleted.
 */
export function loadHosts(dir: string): HostList {
  let raw: string;
  try {
    raw = readFileSync(join(dir, FILE_NAME), "utf8");
  } catch {
    return emptyList();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyList();
  }
  return parseHostList(parsed) ?? emptyList();
}

/** Persist atomically: write a tmp file in the same directory, then rename over the target. */
export function saveHosts(dir: string, list: HostList): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, FILE_NAME);
  const tmp = join(dir, `${FILE_NAME}.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", "utf8");
  renameSync(tmp, target);
}

/**
 * Validate + normalize, append, set active, persist. Nothing is written on a
 * validation error. `remote` (optional) is the `rk remote` name for SSH-only
 * hosts — persisted only when non-empty.
 */
export function addHost(dir: string, name: string, urlInput: string, remote?: string): AddResult {
  const normalized = normalizeOrigin(urlInput);
  if (!normalized.ok) return normalized;
  const list = loadHosts(dir);
  const host: HostEntry = {
    id: randomUUID(),
    name: name.trim() || normalized.origin,
    url: normalized.origin,
  };
  const remoteName = remote?.trim() ?? "";
  if (remoteName !== "") host.remote = remoteName;
  const next: HostList = {
    version: 1,
    activeId: host.id,
    hosts: [...list.hosts, host],
  };
  saveHosts(dir, next);
  return { ok: true, list: next, host };
}

/** Remove by id; when the active host is removed, the first remaining becomes active. */
export function removeHost(dir: string, id: string): HostList {
  const list = loadHosts(dir);
  const hosts = list.hosts.filter((h) => h.id !== id);
  const activeId =
    list.activeId === id ? (hosts.length > 0 ? hosts[0].id : null) : list.activeId;
  const next: HostList = { version: 1, activeId, hosts };
  saveHosts(dir, next);
  return next;
}

export function setActiveHost(dir: string, id: string): HostList {
  const list = loadHosts(dir);
  if (!list.hosts.some((h) => h.id === id)) return list;
  const next: HostList = { ...list, activeId: id };
  saveHosts(dir, next);
  return next;
}

/**
 * Record the last-visited SPA path for a host. Unknown id or an unchanged
 * value is a no-op (nothing written) — capture runs on every switch/add/
 * close, so the fast path avoids rewriting an identical file.
 */
export function setHostLastPath(dir: string, id: string, lastPath: string): HostList {
  const list = loadHosts(dir);
  const entry = list.hosts.find((h) => h.id === id);
  if (!entry || entry.lastPath === lastPath) return list;
  const next: HostList = {
    ...list,
    hosts: list.hosts.map((h) => (h.id === id ? { ...h, lastPath } : h)),
  };
  saveHosts(dir, next);
  return next;
}

/**
 * Rename a host entry. Names are display-only — entries key on the immutable
 * id, and names are not unique (several entries can share one origin). Trim
 * follows the `addHost` convention; an unknown id, an empty/whitespace-only
 * trimmed value, or an unchanged name is a no-op (nothing written) — the
 * store's keep-current convention rather than a rejection.
 */
export function setHostName(dir: string, id: string, name: string): HostList {
  const list = loadHosts(dir);
  const trimmed = name.trim();
  const entry = list.hosts.find((h) => h.id === id);
  if (!entry || trimmed === "" || entry.name === trimmed) return list;
  const next: HostList = {
    ...list,
    hosts: list.hosts.map((h) => (h.id === id ? { ...h, name: trimmed } : h)),
  };
  saveHosts(dir, next);
  return next;
}

/**
 * Re-point a registration at a new origin — the Edit Host dialog's URL field.
 * The caller (the `servers:set-url` handler) has already run `normalizeOrigin`,
 * so `origin` arrives validated; the mutator keeps the family shape (unknown
 * id / unchanged value are no-ops that write nothing). A changed origin drops
 * `lastPath`: the remembered route belongs to the OLD origin, and restoring it
 * against the new one would deep-link into a different instance's tree.
 */
export function setHostUrl(dir: string, id: string, origin: string): HostList {
  const list = loadHosts(dir);
  const entry = list.hosts.find((h) => h.id === id);
  if (!entry || entry.url === origin) return list;
  const next: HostList = {
    ...list,
    hosts: list.hosts.map((h) => {
      if (h.id !== id) return h;
      const { lastPath: _dropped, ...rest } = h;
      return { ...rest, url: origin };
    }),
  };
  saveHosts(dir, next);
  return next;
}

/**
 * Strict hex gate for a reported accent color — byte-for-byte the SPA
 * consumer's `HOST_ACCENT_HEX` (app/frontend/src/lib/shell-strip.ts), so
 * nothing the shell persists can fail the SPA's row-paint validation. The
 * packages share no code; the mirror is deliberate.
 */
const HOST_ACCENT_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** True when `value` is a strict `#RGB`/`#RRGGBB`/`#RRGGBBAA` hex color. */
export function isHostAccentHex(value: string): boolean {
  return HOST_ACCENT_HEX.test(value);
}

/**
 * Record the host's instance accent color (the SPA's raw `accent:set` report,
 * or a `did-change-theme-color` blend for older SPAs — main.ts owns that
 * precedence). Unknown id or an unchanged value is a no-op (nothing written) —
 * capture fires on every report, so the fast path avoids rewriting an
 * identical file.
 */
export function setHostAccentColor(dir: string, id: string, accentColor: string): HostList {
  const list = loadHosts(dir);
  const entry = list.hosts.find((h) => h.id === id);
  if (!entry || entry.accentColor === accentColor) return list;
  const next: HostList = {
    ...list,
    hosts: list.hosts.map((h) => (h.id === id ? { ...h, accentColor } : h)),
  };
  saveHosts(dir, next);
  return next;
}

/**
 * Move a host to `toIndex`, clamped to the list bounds. Order is
 * user-meaningful — it IS the ⌥⌘1–9/⇧Ctrl+1–9 accelerator map — so this is
 * the reorder seam behind `servers:reorder`. Unknown id or a move landing on
 * the entry's current index is a no-op (nothing written); `activeId` and
 * every other field are untouched — only array order changes.
 */
export function moveHost(dir: string, id: string, toIndex: number): HostList {
  const list = loadHosts(dir);
  const from = list.hosts.findIndex((h) => h.id === id);
  if (from === -1) return list;
  const to = Math.min(Math.max(toIndex, 0), list.hosts.length - 1);
  if (to === from) return list;
  const hosts = [...list.hosts];
  const [moved] = hosts.splice(from, 1);
  hosts.splice(to, 0, moved);
  const next: HostList = { ...list, hosts };
  saveHosts(dir, next);
  return next;
}

/**
 * Resolve the host to load at startup / after a mutation: the active entry,
 * falling back to the first host when `activeId` dangles, `null` when the
 * list is empty (welcome page).
 */
export function resolveActiveHost(list: HostList): HostEntry | null {
  if (list.hosts.length === 0) return null;
  return list.hosts.find((h) => h.id === list.activeId) ?? list.hosts[0];
}

/**
 * Resolve which entry owns a displayed origin (last-path capture). Several
 * entries can share one origin (`addHost` never dedupes) — the active entry
 * wins among the matches, else the first match; `null` when nothing matches.
 */
export function findHostByOrigin(list: HostList, origin: string): HostEntry | null {
  const matches = list.hosts.filter((h) => h.url === origin);
  return matches.find((h) => h.id === list.activeId) ?? matches[0] ?? null;
}

export interface HostInfo {
  id: string;
  name: string;
  url: string;
  active: boolean;
  /** The entry's persisted instance accent color, when known (never
   *  null/empty — absent entries omit the field). */
  accentColor?: string;
  /** Cached waiting-agent count from the view registry — NEVER filled here
   *  (this module is store-pure); the `servers:list` handler in main.ts
   *  joins it in. */
  waiting?: number;
}

/**
 * Read-only projection of the list for the `servers:list` IPC surface (the
 * channel name is the SPA-facing contract and keeps its server naming): every
 * entry plus an `active` flag derived via `resolveActiveHost`, so a dangling
 * `activeId` marks the same first-host fallback that startup would load. The
 * optional `accentColor` rides along when the entry carries one.
 */
export function hostInfos(list: HostList): HostInfo[] {
  const activeId = resolveActiveHost(list)?.id ?? null;
  return list.hosts.map(({ id, name, url, accentColor }) => ({
    id,
    name,
    url,
    active: id === activeId,
    ...(accentColor !== undefined ? { accentColor } : {}),
  }));
}
