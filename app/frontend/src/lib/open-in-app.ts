/**
 * Pure model for the Open-in-App split-button (260722-6d0f): the static
 * editor deeplink table, the local/remote client branch, the section
 * visibility rules, and the last-used-target preference.
 *
 * The deeplink templates live HERE, in run-kit's frontend, and nowhere else —
 * an explicit design decision: host-side detection is a wrong/inverted signal
 * for deeplinks (e.g. Windsurf installed on the client but not the host), so
 * `wt` carries zero URL-scheme knowledge and the templates are a plain TS
 * const. The `vscode-remote/ssh-remote+{host}{path}` grammar is the same one
 * Coder/Codespaces use — the only mechanism a web page has to open a host
 * folder in a client-local editor.
 */
import type { OpenApp } from "@/api/client";
import type { WindowInfo } from "@/types";

/** One editor deeplink template. `url` composes the client-side URI that opens
 *  `path` on `host` — an SSH destination: either the ssh_host setting's alias
 *  from the client's ~/.ssh/config or the derived `user@hostname` fallback (see
 *  `resolveDeeplinkHost`) — in the client-local editor. */
export type DeeplinkApp = {
  id: string;
  label: string;
  url: (host: string, path: string) => string;
};

/** The v1 deeplink set — VS Code family editors sharing the ssh-remote URI
 *  grammar. All templates are offered unconditionally when remote: client
 *  installs are unknowable from a web page, and a dead scheme no-ops on
 *  click. (JetBrains Gateway has a divergent grammar — a later add.)
 *
 *  COUPLED to the desktop shell's editor-deeplink scheme allowlist
 *  (`EDITOR_DEEPLINK_SCHEMES` in `app/desktop/src/window-open.ts`,
 *  260801-sm6g): in the Electron shell these URLs only reach
 *  `shell.openExternal` when their scheme is on that fixed allowlist —
 *  adding an editor HERE requires adding its scheme THERE (and a shell
 *  release), or the new editor's deeplink is silently dropped in the shell. */
export const DEEPLINK_APPS: DeeplinkApp[] = [
  { id: "vscode",   label: "VS Code",  url: (host, path) => `vscode://vscode-remote/ssh-remote+${host}${path}` },
  { id: "cursor",   label: "Cursor",   url: (host, path) => `cursor://vscode-remote/ssh-remote+${host}${path}` },
  { id: "windsurf", label: "Windsurf", url: (host, path) => `windsurf://vscode-remote/ssh-remote+${host}${path}` },
];

/**
 * True when the browser is on the run-kit host itself — the server-exec
 * (`wt open`) path applies and deeplinks are pointless. Keyed on
 * `location.hostname`; jsdom and dev/e2e all resolve to `localhost`.
 * (`location.hostname` reports the bracketed `[::1]` form for IPv6 URLs; the
 * bare `::1` is included defensively.)
 */
export function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * The effective SSH destination the editor deeplinks embed — the
 * ssh_host-unset fallback chain (260722-fc3b):
 *
 *  1. `sshHost` set → use it VERBATIM, never `user@`-prefixed — an alias
 *     carries user/port/key from the client's ~/.ssh/config.
 *  2. Unset AND the client is remote → derive `${sshUser}@${hostname}` from
 *     the name the browser reached this host by (on a tailnet it is
 *     SSH-reachable too) plus the server-derived username; the `user@`
 *     prefix is omitted when `sshUser` is empty. The hostname is used
 *     as-given — no reachability guessing (behind an HTTP-only tunnel the
 *     editor shows its own connect error; the accepted trade is "shown ⇒
 *     works on tailnets, errors on tunnels").
 *  3. Local client → empty (deeplinks are pointless on the host itself).
 */
export function resolveDeeplinkHost(opts: {
  sshHost: string;
  sshUser: string;
  hostname: string;
}): string {
  const { sshHost, sshUser, hostname } = opts;
  if (sshHost) return sshHost;
  if (isLocalHostname(hostname) || !hostname) return "";
  return sshUser ? `${sshUser}@${hostname}` : hostname;
}

/**
 * One actionable entry in the Open menu / palette. `id` is kind-qualified
 * (`deeplink:vscode` / `host:vscode`) so a deeplink and a host app for the
 * same editor never collide in the last-used preference.
 *
 *  - `deeplink`: navigate the client to `url` (browser shows its own
 *    "Open <app>?" confirm). Always editors (the vscode-remote grammar).
 *  - `host`: POST /api/open with `appId` (server-side `wt open` launch);
 *    `appKind` is the wt registry `kind` (editor/terminal/file-manager),
 *    feeding the row icon's generic fallback.
 */
export type OpenTarget =
  | { kind: "deeplink"; id: string; label: string; url: string }
  | { kind: "host"; id: string; label: string; appId: string; appKind?: string };

/**
 * Build the available open targets from the section-visibility rules:
 *
 *  - local client → host section only (server exec is THE mechanism; no
 *    deeplink section even when sshHost is set — the folder is already on
 *    this machine).
 *  - remote client → deeplink section (always — the effective host comes
 *    from `resolveDeeplinkHost`, deriving `user@hostname` when ssh_host
 *    is unset) plus the host section as an explicitly labeled "on host"
 *    escape hatch.
 *  - host section hidden whenever the registry is empty.
 *
 * Zero returned targets ⇒ the Open control renders nothing.
 */
export function buildOpenTargets(opts: {
  hostname: string;
  sshHost: string;
  sshUser: string;
  hostApps: OpenApp[];
  path: string;
}): OpenTarget[] {
  const { hostname, sshHost, sshUser, hostApps, path } = opts;
  const targets: OpenTarget[] = [];
  if (!path) return targets;

  const local = isLocalHostname(hostname);
  const deeplinkHost = resolveDeeplinkHost({ sshHost, sshUser, hostname });
  if (!local && deeplinkHost) {
    for (const app of DEEPLINK_APPS) {
      targets.push({
        kind: "deeplink",
        id: `deeplink:${app.id}`,
        label: app.label,
        url: app.url(deeplinkHost, path),
      });
    }
  }

  // Default-marked apps (wt's detected default) lead the host section; the
  // partition is stable so wt's registry order is preserved within each group.
  const orderedHostApps = [
    ...hostApps.filter((app) => app.default),
    ...hostApps.filter((app) => !app.default),
  ];
  for (const app of orderedHostApps) {
    targets.push({
      kind: "host",
      id: `host:${app.id}`,
      label: app.label,
      appId: app.id,
      appKind: app.kind,
    });
  }

  return targets;
}

/**
 * The folder an Open action targets on the Terminal route: the active pane's
 * cwd, falling back to the first pane's cwd, then the window's
 * `worktreePath` (the list-windows `#{pane_current_path}`) — the same
 * derivation chain the backend's repo-root derivation uses. Empty when the
 * window carries no usable path.
 */
export function activePaneCwd(win: WindowInfo | null | undefined): string {
  if (!win) return "";
  const panes = win.panes ?? [];
  const active = panes.find((p) => p.isActive);
  if (active?.cwd) return active.cwd;
  const first = panes[0];
  if (first?.cwd) return first.cwd;
  return win.worktreePath ?? "";
}

/**
 * Client-side "last app opened with" preference. Per-client only
 * (Constitution II — no backend persistence); the `hexokit-*` key convention
 * mirrors `hexokit-terminal-font-size` / `hexokit-last-pinned-board`.
 * Reads/writes are best-effort try/catch-noop so private mode / quota / SSR
 * never throw.
 */
export const LAST_USED_OPEN_TARGET_KEY = "hexokit-open-last-used";

/** Read the last-used open-target id (`deeplink:vscode` / `host:iterm`).
 *  Returns `null` when absent or when localStorage is unavailable. NOT
 *  validated against the live targets here — callers resolve it via
 *  `resolveLastUsedTarget`. */
export function readLastUsedOpenTarget(): string | null {
  try {
    return localStorage.getItem(LAST_USED_OPEN_TARGET_KEY);
  } catch {
    return null;
  }
}

/** Persist the last-used open-target id. Best-effort — failures swallowed. */
export function writeLastUsedOpenTarget(id: string): void {
  try {
    localStorage.setItem(LAST_USED_OPEN_TARGET_KEY, id);
  } catch {
    /* noop — best-effort persistence */
  }
}

/** Resolve a stored last-used id against the live targets. A stale id (the
 *  target disappeared — registry change, sshHost unset) resolves to null so
 *  the split-button's primary click falls back to opening the menu. */
export function resolveLastUsedTarget(
  targets: OpenTarget[],
  storedId: string | null,
): OpenTarget | null {
  if (!storedId) return null;
  return targets.find((t) => t.id === storedId) ?? null;
}
