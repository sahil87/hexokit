/**
 * Shared tmux fixture helpers for e2e specs.
 *
 * Every spec that seeds real tmux state uses the same lifecycle: create a
 * detached 80x24 session on the isolated e2e server in `beforeAll`, tear it
 * down in `afterAll`. These helpers centralize that lifecycle (plus the named
 * window / per-window idle-command / second-server variants) so a teardown or
 * targeting fix lands in one place instead of ~35 copies.
 *
 * TARGETING: window-scoped tmux commands (`new-window`, `list-windows`) treat
 * a bare `-t <name>` as a WINDOW target — a window named like the session
 * hijacks it (creation lands in the wrong session, index-joins show wrong
 * panes). All targets here use the `=name` exact-match session form
 * (`=name:` where the command takes a target-window) — never bare `-t name`.
 *
 * EPHEMERAL + MANAGED MARKING: `createSession` sets the `@rk_srv_ephemeral 1`
 * creator opt-out mark and the `@rk_srv_managed 1` provenance mark (both
 * server-scoped) on the target server after its `new-session` succeeds —
 * one seam covering the primary and every `rk-test-e2e-<role>-<pid>-<epoch>`
 * secondary the multi-server specs spin up. Idempotent; re-marking an
 * already-marked server is a no-op. The managed mark keeps the WS-attach
 * conf reload sourcing rk's tmux.conf into rig servers (unmarked = external
 * = rk pushes no conf, and passthrough-dependent specs would break).
 *
 * All subprocess calls use `execFileSync` with argument arrays — no shell
 * string construction, so window names and idle commands need no quoting.
 * A window `command` is passed through as a single tmux argument; tmux runs
 * it via `sh -c`, exactly as the previous shell-string copies did.
 */
import { execFileSync } from "node:child_process";

/** The isolated tmux server socket the e2e suite runs against. */
export const TMUX_SERVER = process.env.E2E_TMUX_SERVER ?? "rk-test-e2e";

/** This worktree's socket family anchor (trailing hyphen included). Specs
 *  name secondary servers `${TMUX_FAMILY}<role>-<pid>-<epoch>` so the cleanup
 *  glob, global-teardown scan, and RK_SERVER_ALLOWLIST all match the family
 *  by prefix; hyphen-free tokens make cross-worktree prefix collisions
 *  impossible by construction (see scripts/e2e-env.sh). */
export const TMUX_FAMILY = process.env.E2E_TMUX_FAMILY ?? `${TMUX_SERVER}-`;

export interface TmuxOptions {
  /** tmux server socket name (`tmux -L`); defaults to {@link TMUX_SERVER}. */
  server?: string;
}

/** A named window to create, optionally running `command` in its pane
 *  (e.g. an idle `sh -c 'sleep 300'` keeping the pane stable). */
export interface WindowSpec {
  name: string;
  command?: string;
}

/** Run a tmux command against the given server and return its stdout.
 *  Throws on non-zero exit (with tmux's stderr appended to the message) —
 *  lifecycle helpers wrap this in best-effort try/catch; mid-test callers
 *  usually want the error. Module-private: specs use the named helpers. */
function tmux(args: string[], opts: TmuxOptions = {}): string {
  try {
    return execFileSync("tmux", ["-L", opts.server ?? TMUX_SERVER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    if (err instanceof Error && stderr) err.message += `\ntmux: ${stderr}`;
    throw err;
  }
}

export interface CreateSessionOptions extends TmuxOptions {
  /** Named windows to create: the first via `new-session -n`, the rest via
   *  `new-window`, in order. Strings are shorthand for `{ name }`. Omit for
   *  a single default-named window (plain `new-session`). */
  windows?: Array<string | WindowSpec>;
}

/**
 * Create a detached 80x24 session, pre-killing any leftover session with the
 * same name. Best-effort (failures are swallowed), matching the try/catch
 * pattern the per-spec copies used — a genuinely broken tmux surfaces in the
 * test body instead.
 */
export function createSession(
  session: string,
  opts: CreateSessionOptions = {},
): void {
  killSession(session, opts);
  const windows = (opts.windows ?? []).map((w) =>
    typeof w === "string" ? { name: w } : w,
  );
  try {
    const [first, ...rest] = windows;
    const args = ["new-session", "-d", "-s", session, "-x", "80", "-y", "24"];
    if (first) {
      args.push("-n", first.name);
      if (first.command) args.push(first.command);
    }
    tmux(args, opts);
    // Convention: every server the specs birth carries the @rk_srv_ephemeral
    // creator opt-out mark (idempotent — the primary is already marked by
    // scripts/test-e2e.sh) plus @rk_srv_managed, so the WS-attach conf reload
    // still sources rk's tmux.conf into it (an unmarked server is external
    // and rk no longer pushes conf — allow-passthrough etc. would be off).
    tmux(["set-option", "-s", "@rk_srv_ephemeral", "1"], opts);
    tmux(["set-option", "-s", "@rk_srv_managed", "1"], opts);
    for (const w of rest) {
      newWindow(session, w.name, { server: opts.server, command: w.command });
    }
  } catch {
    // Best-effort — matches the copied per-file pattern.
  }
}

/** Best-effort `kill-session` — an already-gone session does not throw. */
export function killSession(session: string, opts: TmuxOptions = {}): void {
  try {
    tmux(["kill-session", "-t", `=${session}`], opts);
  } catch {
    // Best-effort.
  }
}

/** Best-effort `kill-server` — teardown for scratch second servers (A/B
 *  specs). Only ever aim this at a spec-created scratch socket. */
export function killServer(server: string): void {
  try {
    tmux(["kill-server"], { server });
  } catch {
    // Best-effort — server may already be gone.
  }
}

export interface NewWindowOptions extends TmuxOptions {
  /** Shell command for the new window's pane (tmux runs it via `sh -c`). */
  command?: string;
  /** Start directory for the new window's pane (tmux `-c`) — e.g. `/tmp` for
   *  a non-repo cwd (its code folder falls back to the raw cwd, so it stays
   *  code-capable — no longer the availability-negative case). */
  cwd?: string;
}

/** Create a named window in `session` (exact-match target). Throws on
 *  failure — mid-test callers should see the error. */
export function newWindow(
  session: string,
  name: string,
  opts: NewWindowOptions = {},
): void {
  const args = ["new-window", "-t", `=${session}:`, "-n", name];
  if (opts.cwd) args.push("-c", opts.cwd);
  if (opts.command) args.push(opts.command);
  tmux(args, opts);
}

/** Synchronously list a session's windows (tmux-side truth, index order).
 *  Replaces the per-spec `list-windows -F` parse copies. */
export function listWindows(
  session: string,
  opts: TmuxOptions = {},
): Array<{ windowId: string; name: string }> {
  const out = tmux(
    ["list-windows", "-t", `=${session}`, "-F", "#{window_id}\t#{window_name}"],
    opts,
  ).trim();
  if (!out) return [];
  return out.split("\n").map((line) => {
    const tab = line.indexOf("\t");
    return { windowId: line.slice(0, tab), name: line.slice(tab + 1) };
  });
}

/** Synchronously list the server's attached clients: each client's session
 *  and size (tmux-side truth). A server with no clients yields []. */
export function listClients(
  opts: TmuxOptions = {},
): Array<{ session: string; width: number; height: number }> {
  const out = tmux(
    ["list-clients", "-F", "#{client_session}\t#{client_width}\t#{client_height}"],
    opts,
  ).trim();
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [session, width, height] = line.split("\t");
    return { session, width: Number(width), height: Number(height) };
  });
}

/** Set a user option at SESSION scope (exact-match `=name:` target — a bare
 *  `-t <session>` is a window target). Throws on failure. */
export function setSessionOption(
  session: string,
  option: string,
  value: string,
  opts: TmuxOptions = {},
): void {
  tmux(["set-option", "-t", `=${session}:`, option, value], opts);
}

/** Read a user option held at SESSION scope (`-qv`: empty when unset, exit 0
 *  either way). */
export function sessionOption(
  session: string,
  option: string,
  opts: TmuxOptions = {},
): string {
  return tmux(["show-options", "-qv", "-t", `=${session}:`, option], opts).trim();
}

/** Set a user option at WINDOW scope (a window-id target like `@3`). Throws
 *  on failure. */
export function setWindowOption(
  windowId: string,
  option: string,
  value: string,
  opts: TmuxOptions = {},
): void {
  tmux(["set-option", "-w", "-t", windowId, option, value], opts);
}

/** Read a user option held at WINDOW scope (`-wvq`: empty when unset, exit 0
 *  either way — tmux exits 1 for an unknown WINDOW option only when the
 *  window id is bad, which mid-test callers should see). */
export function windowOption(
  windowId: string,
  option: string,
  opts: TmuxOptions = {},
): string {
  try {
    return tmux(["show-option", "-wvq", "-t", windowId, option], opts).trim();
  } catch {
    return "";
  }
}

/** Stamp the slot-1 web tab the way the frontend's address bar / migration
 *  does: `@rk_win_web_1` plus `@rk_win_web_active 1`. */
export function stampWebTab(
  windowId: string,
  url: string,
  opts: TmuxOptions = {},
): void {
  setWindowOption(windowId, "@rk_win_web_1", url, opts);
  setWindowOption(windowId, "@rk_win_web_active", "1", opts);
}

/** Stamp a full web-tab family: one `@rk_win_web_<i>` per URL (1-based slot
 *  order) plus `@rk_win_web_active`. */
export function stampWebTabs(
  windowId: string,
  urls: string[],
  active: number,
  opts: TmuxOptions = {},
): void {
  urls.forEach((url, i) => {
    setWindowOption(windowId, `@rk_win_web_${i + 1}`, url, opts);
  });
  setWindowOption(windowId, "@rk_win_web_active", String(active), opts);
}
