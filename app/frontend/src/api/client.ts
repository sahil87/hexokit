import type { ProjectSession } from "@/types";
import type { ReviewDocument, ReviewFileBody, ReviewSide } from "@/lib/review";
import type { WorkingSnapshot } from "@/lib/working";

export type { ProjectSession };

/** Append ?server= to a URL (handles existing query params). */
function withServer(url: string, server: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}server=${encodeURIComponent(server)}`;
}

/** In-flight GET request deduplication map. */
const inFlight = new Map<string, Promise<Response>>();

/** Deduplicate concurrent GET requests to the same URL. Non-GET requests pass through. */
export async function deduplicatedFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method?.toUpperCase() ?? "GET";
  if (method !== "GET") return fetch(url, init);

  const existing = inFlight.get(url);
  if (existing) return existing.then(r => r.clone());

  const promise = fetch(url, init).finally(() => inFlight.delete(url));
  inFlight.set(url, promise);
  return promise.then(r => r.clone());
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly windowId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Throw an error from a JSON error response, falling back to status text. */
export async function throwOnError(res: Response): Promise<never> {
  const data: unknown = await res.json().catch(() => null);
  let message = `Request failed: ${res.status}`;
  let code: string | undefined;
  let windowId: string | undefined;
  if (typeof data === "object" && data !== null) {
    if ("error" in data && typeof data.error === "string") message = data.error;
    if ("code" in data && typeof data.code === "string") code = data.code;
    if ("windowId" in data && typeof data.windowId === "string") windowId = data.windowId;
  }
  throw new ApiError(message, res.status, code, windowId);
}

export interface HealthResponse {
  status: string;
  hostname: string;
  /** Optional SSH alias (the ssh_host setting) remote clients use to reach this
   *  host. Feeds the Open button's editor ssh-remote deeplinks (used verbatim
   *  when set); absent when unset (remote clients then derive
   *  `${sshUser}@${location.hostname}`). */
  sshHost?: string;
  /** The username the daemon runs as (os/user.Current, derived server-side).
   *  Composes the derived deeplink host when ssh_host is unset; absent
   *  when the lookup failed (the `user@` prefix is omitted then). */
  sshUser?: string;
  /** Optional instance display-name override (settings.yaml `instance_name`).
   *  Display surfaces prefer it over `hostname`; absent when unset. The real
   *  hostname stays authoritative for the accent hash and SSH deeplinks. */
  instanceName?: string;
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await deduplicatedFetch("/api/health");
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** One host-detected launch target from GET /api/open-apps (wt registry).
 *  `default` is wt's detected-default marker (absent unless true). */
export interface OpenApp {
  id: string;
  label: string;
  kind?: string;
  default?: boolean;
}

/**
 * Fetch the host app registry for the Open button's "on host" section.
 * Fail-silent end to end (mirrors the server's own degradation): any network
 * error, non-200, or non-array body resolves to `[]` — an absent/old wt on
 * the host must never surface as a client error.
 */
export async function getOpenApps(): Promise<OpenApp[]> {
  try {
    const res = await deduplicatedFetch("/api/open-apps");
    if (!res.ok) return [];
    const body: unknown = await res.json();
    return Array.isArray(body) ? (body as OpenApp[]) : [];
  } catch {
    return [];
  }
}

/**
 * Launch a host app on a folder via POST /api/open. `path` must be a
 * server-derived pane cwd / worktree path — the backend validates it against
 * live tmux state and rejects anything else.
 */
export async function openInApp(
  server: string,
  path: string,
  app: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(withServer("/api/open", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, app }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function getSessions(server: string): Promise<ProjectSession[]> {
  const res = await deduplicatedFetch(withServer("/api/sessions", server));
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function setSessionOrder(server: string, order: string[]): Promise<void> {
  const res = await fetch(withServer("/api/sessions/order", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
  if (!res.ok) await throwOnError(res);
}

export async function createSession(
  server: string,
  name: string,
  cwd?: string,
): Promise<{ ok: boolean }> {
  const body: Record<string, string> = { name };
  if (cwd) body.cwd = cwd;
  const res = await fetch(withServer("/api/sessions", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function renameSession(
  server: string,
  session: string,
  name: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/sessions/${encodeURIComponent(session)}/rename`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** The deterministic order keys the sort-windows verb accepts (backend allowlist). */
export type SortWindowsBy = "status" | "created" | "name";

/** The applied window-ID order + how many moves it took. */
export interface SortWindowsResult {
  order: string[];
  moved: number;
}

export async function sortSessionWindows(
  server: string,
  session: string,
  by: SortWindowsBy[],
): Promise<SortWindowsResult> {
  const res = await fetch(
    withServer(`/api/sessions/${encodeURIComponent(session)}/sort-windows`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function killSession(server: string, session: string): Promise<{ ok: boolean }> {
  const res = await fetch(withServer(`/api/sessions/${encodeURIComponent(session)}/kill`, server), {
    method: "POST",
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function createWindow(
  server: string,
  session: string,
  name?: string,
  cwd?: string,
  webUrl?: string,
): Promise<{ ok: boolean }> {
  // `name` is optional: omitting it (or passing an empty string) tells the
  // backend to let tmux auto-name the window to its folder basename via
  // automatic-rename-format. Explicit names (renames, iframe windows) are
  // still sent. Matches the existing omit-when-absent handling for cwd/webUrl.
  const body: Record<string, string> = {};
  if (name) body.name = name;
  if (cwd) body.cwd = cwd;
  // The web arm: a URL creates an iframe window pointed at it. The backend
  // keeps these body field names this release (the options write is its job).
  if (webUrl) {
    body.rkType = "iframe";
    body.rkUrl = webUrl;
  }
  const res = await fetch(withServer(`/api/sessions/${encodeURIComponent(session)}/windows`, server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

// --- Recently-closed windows (the per-server kill-seam record ring) ---

/** One pane of a closed window's kill-time capture. */
export interface ClosedWindowPane {
  id: string;
  index: number;
  cwd?: string;
  command?: string;
  active?: boolean;
}

/** One entry on a server's recently-closed ring: the window as captured before
 *  the kill, plus any agent identity the active pane carried. The frontend
 *  reads only `window.name`, `session`, and the agent session identity pair —
 *  the rest round-trips to the reopen/resume routes untouched. */
export interface ClosedWindow {
  id: string;
  /** RFC3339 kill timestamp. */
  closedAt: string;
  server: string;
  session: string;
  window: {
    index: number;
    id: string;
    name: string;
    active?: boolean;
    layout?: string;
    color?: string;
    rkLayout?: string;
    webTabs?: string[];
    webRoots?: string[];
    webActive?: number;
    codeRoot?: string;
    marker?: string;
    flair?: string;
    role?: string;
    note?: string;
    panes: ClosedWindowPane[];
  };
  /** Agent session identity of the active pane at kill time. Absent when the
   *  window carried none. */
  agentProvider?: string;
  agentRef?: string;
}

export async function killWindow(
  server: string,
  windowId: string,
): Promise<{ ok: boolean; closed?: ClosedWindow }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/kill`, server),
    { method: "POST" },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** List a server's recently-closed ring, newest-first. */
export async function listClosedWindows(server: string): Promise<ClosedWindow[]> {
  const res = await deduplicatedFetch(withServer("/api/windows/closed", server));
  if (!res.ok) await throwOnError(res);
  const data = (await res.json()) as { closed?: ClosedWindow[] };
  return data.closed ?? [];
}

/** Reopen a closed record as a fresh-shell window (same session/name/cwd/
 *  options). Returns the riff-shaped spawn result so the caller navigates as
 *  it does after a fork. Throws an HttpError carrying the status: 409 names
 *  the vanished owning session (the record is dropped server-side), 404 an
 *  unknown record id. */
export async function reopenClosedWindow(
  server: string,
  id: string,
): Promise<RiffSpawnResult> {
  const res = await fetch(
    withServer(`/api/windows/closed/${encodeURIComponent(id)}/reopen`, server),
    { method: "POST" },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new HttpError(res.status, (data as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

/** Drop a closed record without reopening it (toast dismissed, resume
 *  declined). Idempotent by contract; callers tolerate a 404. */
export async function dismissClosedWindow(
  server: string,
  id: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/windows/closed/${encodeURIComponent(id)}/dismiss`, server),
    { method: "POST" },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** Resume the record's captured agent into a NEW window, replacing the
 *  just-reopened fresh-shell window (`replaceWindowId`, killed server-side).
 *  Throws on a non-ok response: 400 for a non-repo cwd, 404 when the record
 *  carries no resolvable claude agent ref. */
export async function resumeClosedWindow(
  server: string,
  id: string,
  replaceWindowId: string,
): Promise<RiffSpawnResult> {
  const res = await fetch(
    withServer(`/api/windows/closed/${encodeURIComponent(id)}/resume`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replaceWindowId }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function moveWindow(
  server: string,
  windowId: string,
  targetIndex: number,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/move`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetIndex }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function moveWindowToSession(
  server: string,
  windowId: string,
  targetSession: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/move-to-session`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetSession }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function renameWindow(
  server: string,
  windowId: string,
  name: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/rename`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** An HTTP error carrying the response status, so callers can branch on it. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export type WindowSendMode = "submit" | "insert-line" | "raw" | "enter";

/**
 * Carries compose intent only: `mode` selects the server-side injection
 * strategy, and the server re-resolves the window's active pane per request —
 * or, with `target: "agent"` (the selection broadcast), the window's AGENT
 * pane via the @rk_pane_agent_session rollup, failing closed (404) when no
 * pane carries an agent session. Non-OK responses become `ApiError`s whose `code` separates
 * staged-but-unsent text from an unconfirmed submit because those outcomes
 * require opposite resend advice.
 */
export async function sendToWindow(
  server: string,
  windowId: string,
  text: string,
  mode: WindowSendMode,
  target?: "agent",
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/send`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target === "agent" ? { text, mode, target } : { text, mode }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * Hand the server's operator window a templated work item ABOUT the subject
 * window (`windowId`) — the operator actuation seam's one consumer-facing
 * call. The body carries the closed-set
 * template id plus, when non-empty, the user's `text` (admitted only on
 * templates the backend declares acceptsText — e.g. the user-message chat
 * template, which wraps it in a server-derived source envelope; chat templates
 * also skip the busy gate and the queue, so they never resolve a queued
 * outcome). Every other prompt fact is derived server-side; busy non-chat
 * requests resolve as a queued outcome; `throwOnError` keeps structured
 * validation, queue-full, and delivery errors on the throwing path. The
 * eventual result (e.g. a rename) arrives via the normal SSE derive tick.
 */
export async function sendOperatorRequest(
  server: string,
  windowId: string,
  template: string,
  text?: string,
): Promise<OperatorRequestResult> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/operator-request`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(text ? { template, text } : { template }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return parseOperatorRequestResult(res);
}

export type OperatorRequestResult =
  | { outcome: "delivered" }
  | { outcome: "queued" };

function isQueuedOperatorResponse(value: unknown): value is { queued: true } {
  return typeof value === "object" && value !== null && "queued" in value && value.queued === true;
}

function isDeliveredOperatorResponse(value: unknown): value is { ok: true } {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

async function parseOperatorRequestResult(res: Response): Promise<OperatorRequestResult> {
  const body: unknown = await res.json();
  if (res.status === 202 && isQueuedOperatorResponse(body)) {
    return { outcome: "queued" };
  }
  if (res.status === 200 && isDeliveredOperatorResponse(body)) {
    return { outcome: "delivered" };
  }
  throw new Error("Invalid operator-request response");
}

/**
 * Server-scoped half of the operator actuation seam — the template has no
 * subject window (spawn-task, find-discussion), so the body additionally
 * carries the user's typed `text` (admitted only on templates the backend
 * declares acceptsText, capped and delimited there). Same shape as
 * sendOperatorRequest: `withServer` + `throwOnError`, with a delivered/queued
 * result for successful responses. The optional `session` scopes the
 * template's facts to one session (admitted only on templates the backend
 * declares acceptsSession; included in the body only when non-empty).
 */
export async function sendServerOperatorRequest(
  server: string,
  template: string,
  text: string,
  session?: string,
): Promise<OperatorRequestResult> {
  const res = await fetch(withServer("/api/operator-request", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(session ? { template, text, session } : { template, text }),
  });
  if (!res.ok) await throwOnError(res);
  return parseOperatorRequestResult(res);
}

/**
 * Start the server's operator via POST /api/operator/start — the daemon
 * execs its own binary as `rk operator -L <server> --json` and answers once
 * the receipt line parses. The optional `windowId` names the window the user
 * is viewing; the daemon derives its pane cwd server-side and passes it as
 * `--dir`, so the operator starts where the user is. A 409 with code
 * `operator_exists` (an operator appeared between the UI's pre-check and the
 * launch) rejects as an ApiError carrying `code` and `windowId` so callers
 * can treat it as success and navigate to the reported window.
 */
export type OperatorStartResult = { windowId: string; server: string };

export async function startOperator(server: string, windowId?: string): Promise<OperatorStartResult> {
  const res = await fetch(withServer("/api/operator/start", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(windowId ? { window: windowId } : {}),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * Fetch the window's full scrollback as plain text from
 * GET /api/windows/{windowId}/history —
 * the server-capture arm of the terminal export menu (`tmux capture-pane -p
 * -S -` on the window's active pane). The body is text/plain; a non-ok
 * response throws the server's structured error.
 */
export async function fetchWindowHistory(
  server: string,
  windowId: string,
): Promise<string> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/history`, server),
  );
  if (!res.ok) await throwOnError(res);
  return res.text();
}

/** The typed result of the code-workspace derivation GET. `no-root` is the
 *  409 shape (the window's `@rk_win_code_root` read empty at request time) —
 *  a resolved status the caller re-drives on the next payload change, never a
 *  throw. */
export type CodeWorkspaceResult =
  | { status: "ok"; path: string; root: string }
  | { status: "no-root" };

/**
 * Derive (on demand) the window's tab-keyed `.code-workspace` file and return
 * its path: GET /api/windows/{windowId}/code-workspace. The handler is the
 * single writer of workspace files, so this read-shaped GET fires only when a
 * code tile is about to mount (or after an editor-initiated folder
 * navigation). A 409 resolves to `{ status: "no-root" }`; every other non-ok
 * response throws as usual.
 */
export async function fetchCodeWorkspace(
  server: string,
  windowId: string,
): Promise<CodeWorkspaceResult> {
  const res = await deduplicatedFetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/code-workspace`, server),
  );
  if (res.status === 409) return { status: "no-root" };
  if (!res.ok) await throwOnError(res);
  const data = (await res.json()) as { path?: string; root?: string };
  if (!data.path || !data.root) {
    throw new Error("Invalid code-workspace response: missing path/root");
  }
  return { status: "ok", path: data.path, root: data.root };
}

/** The typed result of the code-bridge status GET. `unavailable` covers any
 *  non-2xx (including an old backend's 404) and any thrown fetch/parse error —
 *  the first-boot rescue reads it as "not installed" and fails closed. */
export type CodeBridgeResult =
  | { status: "ok"; installed: boolean; startedAt: string; emptyBootAt: string }
  | { status: "unavailable" };

/**
 * Read the window's code-bridge status: GET
 * /api/windows/{windowId}/code-bridge. Issued at the decision points of a
 * code-tile mount generation (baseline at src adoption, verdict at the rescue
 * wait's expiry, plus at most one re-check). NEVER throws — the rescue
 * decision treats every failure as `{ status: "unavailable" }`, so a caller
 * without the route (an old backend) silently disables the rescue rather than
 * erroring. `emptyBootAt` defaults to "" for an older backend that predates
 * the field.
 */
export async function fetchCodeBridge(
  server: string,
  windowId: string,
): Promise<CodeBridgeResult> {
  try {
    const res = await deduplicatedFetch(
      withServer(`/api/windows/${encodeURIComponent(windowId)}/code-bridge`, server),
    );
    if (!res.ok) return { status: "unavailable" };
    const data = (await res.json()) as {
      installed?: boolean;
      startedAt?: string;
      emptyBootAt?: string;
    };
    return {
      status: "ok",
      installed: data.installed === true,
      startedAt: typeof data.startedAt === "string" ? data.startedAt : "",
      emptyBootAt: typeof data.emptyBootAt === "string" ? data.emptyBootAt : "",
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * The shared gui status document (`GET /api/gui/{id}`) — the same shape
 * `rk gui status --json` emits. Host-global (no server param, the
 * `/api/settings` precedent). `reason` carries the not-running explanation
 * the empty state renders verbatim; `apps` + `uptime_seconds` feed the
 * off-confirm dialog. `wm` is the window-manager stamp (`""` when bare or
 * disabled); `wm_hint` is the package-manager-aware install line, present
 * only when enabled ∧ reachable ∧ bare (the backend's omitempty) — the
 * frontend never hardcodes a package name. `locked` is the host-side
 * resolution pin (`rk gui lock`); `geometry` is the host's `gui.geometry`
 * setting — a fixed `WxH` desktop size or `auto` (follow the focused
 * viewer's tile), `""` when disabled. `human_input_ago_ms` is the age of
 * the last relayed human input, omitted when none was seen (omitempty).
 */
/** One window-manager/desktop candidate the server derived from PATH (`kind`
 *  is `session` for session starters, `wm` for bare window managers).
 *  `installed: false` marks a known-but-missing desktop (Linux only), with
 *  `hint` carrying its install line — wording only, never executed. */
export type GuiWMCandidate = {
  name: string;
  label: string;
  kind: "wm" | "session";
  installed: boolean;
  hint?: string;
};

export type GuiStatus = {
  id: string;
  enabled: boolean;
  backend: string;
  reachable: boolean;
  display: string;
  width: number;
  height: number;
  viewers: number;
  wm: string;
  locked: boolean;
  geometry: string;
  human_input_ago_ms?: number;
  wm_hint?: string;
  /** WM/desktop candidates, derived from PATH on every read and never stored;
   *  the server always serializes an array (`[]`, never null). Installed rows
   *  come first, then the known-but-missing desktops with their install hints
   *  (Linux only). Optional here only for old daemons that predate the field. */
  wm_candidates?: GuiWMCandidate[];
  socket: string;
  session: string;
  reason: string;
  apps: { name: string; count: number }[];
  uptime_seconds: number;
};

/**
 * GET /api/gui/{id} — the one-shot status read. Fires only on transitions
 * (the gui tile's unreachable flip) and dialog opens — never polled; the
 * state socket is the reachability authority.
 */
export async function fetchGuiStatus(id = "host"): Promise<GuiStatus> {
  const res = await deduplicatedFetch(`/api/gui/${encodeURIComponent(id)}`);
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * POST /api/gui/{id}/restart (kill + ensure). Resolves `{ ok: true }` on 200;
 * a 409 (`gui disabled`) resolves `{ ok: false, disabled: true }` — the empty
 * state renders "gui turned off" rather than an error toast. Every other
 * non-ok response throws as usual.
 */
export async function restartGui(
  id = "host",
): Promise<{ ok: true } | { ok: false; disabled: true }> {
  const res = await deduplicatedFetch(`/api/gui/${encodeURIComponent(id)}/restart`, {
    method: "POST",
  });
  if (res.status === 409) return { ok: false, disabled: true };
  if (!res.ok) await throwOnError(res);
  return { ok: true };
}

/**
 * POST /api/code-server/restart — the code lens empty state's restart: kill +
 * re-ensure the daemon-managed code-server (the binary is re-resolved, a
 * missing one spawns the install job). Resolves the outcome on 200; any
 * non-ok response throws with the server's error text.
 */
export type CodeServerRestartResult = { status: "started" | "installing" | "external" };

export async function restartCodeServer(): Promise<CodeServerRestartResult> {
  const res = await deduplicatedFetch("/api/code-server/restart", { method: "POST" });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** The two launcher roles (spec docs/specs/gui.md § Agent verbs / § Protocol
 *  and relay — the allowlisted `POST /api/gui/{id}/launch` body). */
export type GuiLaunchApp = "terminal" | "browser";

/** The launch endpoint's parsed body: a ladder miss resolves `ok: false` with
 *  the server-built install hint (a 200 by design — the caller toasts the
 *  hint through the success path; only non-2xx throws). */
export type GuiLaunchResult =
  | { ok: true; app: GuiLaunchApp; argv0: string; pid: number }
  | { ok: false; app: GuiLaunchApp; hint: string };

/**
 * POST /api/gui/{id}/launch with body `{"app": app}`. Resolves the parsed
 * body on any 2xx — including the `ok: false` ladder-miss answer; non-2xx
 * (409 `gui disabled`/not-running, 500 start failure) throws via the shared
 * `throwOnError` path.
 */
export async function launchGuiApp(
  app: GuiLaunchApp,
  id = "host",
): Promise<GuiLaunchResult> {
  const res = await deduplicatedFetch(`/api/gui/${encodeURIComponent(id)}/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * POST /api/gui/{id}/resize with body `{"geometry": geometry}` — the fixed
 * `WxH` desktop size or `auto`. Resolves the parsed 200 body (`was` is the
 * previous setting value); non-2xx (400 out-of-range, 409 disabled or not
 * running, 500 xrandr failure) throws via the shared `throwOnError` path —
 * the server's message becomes the toast.
 */
export async function resizeGui(
  geometry: string,
  id = "host",
): Promise<{ ok: true; geometry: string; was: string }> {
  const res = await deduplicatedFetch(`/api/gui/${encodeURIComponent(id)}/resize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * POST /api/gui/{id}/ping with an empty body — a no-op timing endpoint: the
 * gui stats overlay times this round trip as its RTT sample. Resolves on any
 * 2xx; non-2xx throws via the shared `throwOnError` path.
 */
export async function pingGui(id = "host"): Promise<void> {
  const res = await deduplicatedFetch(`/api/gui/${encodeURIComponent(id)}/ping`, {
    method: "POST",
  });
  if (!res.ok) await throwOnError(res);
}

export async function splitWindow(
  server: string,
  windowId: string,
  horizontal: boolean,
  cwd?: string,
): Promise<{ ok: boolean; pane_id: string }> {
  const body: Record<string, unknown> = { horizontal };
  if (cwd) body.cwd = cwd;
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/split`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function closePane(
  server: string,
  windowId: string,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/close-pane`, server),
    { method: "POST" },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * Partial-merge window options via the unified POST /options endpoint. Each
 * value is a string (set) or null (unset); absent keys are left untouched. The
 * server-side allowlist covers the `@rk_win_*` family (`color`, `layout`,
 * `web_<n>`, `web_active`, `code_root`, `role`, `flair`, `note`, …) plus the
 * retired write-compat keys the backend translates for one release. The whole
 * merge is applied as one atomic chained tmux invocation.
 */
export async function setWindowOptions(
  server: string,
  windowId: string,
  options: Record<string, string | null>,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/options`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ options }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

// --- Cross-tab layout verbs (borrow/return a surface leaf between windows) ---

/** Body for POST /api/layout/borrow. `to` is the window adopting the leaf,
 *  `leaf` the address being moved (`@A/<kind>`), `tree` the adopting window's
 *  new layout tree (already containing the leaf — the server validates it and
 *  chains the current holder's tree-minus-leaf write with it). */
export type LayoutBorrowBody = {
  to: string;
  leaf: string;
  tree: string;
};

/** Body for POST /api/layout/return. `from` is the window currently holding
 *  the leaf; the server recomputes both trees from current tmux state, so the
 *  client sends no tree. A leaf not present in `from` is a 409. */
export type LayoutReturnBody = {
  from: string;
  leaf: string;
};

/** Move a surface leaf into window `to`, unholding it from its current holder
 *  in one chained server-side write. Non-2xx (400 invalid ids/tree, 409
 *  conflicts) rejects via the shared throwOnError path. */
export async function borrowLayout(
  server: string,
  body: LayoutBorrowBody,
): Promise<{ ok: boolean }> {
  const res = await fetch(withServer("/api/layout/borrow", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** Send a held surface leaf back to its home window. Non-2xx (409 leaf not
 *  held by `from`) rejects via the shared throwOnError path. */
export async function returnLayout(
  server: string,
  body: LayoutReturnBody,
): Promise<{ ok: boolean }> {
  const res = await fetch(withServer("/api/layout/return", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * Append a web tab to the window's tab family via
 * POST /api/windows/{windowId}/web (201). `target` is the stored address
 * (callers pass the normalized form). A non-2xx rejects with the server's
 * `error` text verbatim — the family-cap 409 message must reach the UI.
 */
export async function addWebTab(
  server: string,
  windowId: string,
  target: string,
): Promise<{ index: number; existed: boolean; url: string }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/web`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * Remove web tab `n` (the 1-based tmux slot) via
 * POST /api/windows/{windowId}/web/{n}/remove. A non-2xx rejects with the
 * server's `error` text verbatim.
 */
export async function removeWebTab(
  server: string,
  windowId: string,
  n: number,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/web/${n}/remove`, server),
    { method: "POST" },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * Select web tab `n` (the 1-based tmux slot) via
 * POST /api/windows/{windowId}/web/{n}/select. A non-2xx rejects with the
 * server's `error` text verbatim.
 */
export async function selectWebTab(
  server: string,
  windowId: string,
  n: number,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/web/${n}/select`, server),
    { method: "POST" },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * Move web tab `n` (the 1-based tmux slot) to position `to` via
 * POST /api/windows/{windowId}/web/{n}/move (body {"to": m}). A non-2xx
 * rejects with the server's `error` text verbatim.
 */
export async function moveWebTab(
  server: string,
  windowId: string,
  n: number,
  to: number,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/web/${n}/move`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** The GET /api/frame-check response — the backend probe's derived verdict
 *  on whether an absolute external URL can be framed. */
export interface FrameCheckResult {
  reachable: boolean;
  embeddable: boolean;
  status: number;
  reason: string;
}

/**
 * Probe an absolute external URL for frame-refusal headers. Host-global read
 * — no `server` param (the probe targets external hosts, never a tmux
 * server). Fail-silent: a network error resolves to the unreachable shape so
 * the tile renders its connection-error state instead of throwing.
 */
export async function checkFrame(url: string): Promise<FrameCheckResult> {
  try {
    const res = await deduplicatedFetch(`/api/frame-check?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`frame-check failed: ${res.status}`);
    return res.json();
  } catch (e) {
    return {
      reachable: false,
      embeddable: false,
      status: 0,
      reason: e instanceof Error ? e.message : "frame-check request failed",
    };
  }
}

/** Response body of `POST /api/windows/{id}/select`. `activeWindow` is absent
 *  on older daemons — callers treat that as "select executed, active window
 *  unreported". */
export type SelectWindowResult = { ok: boolean; activeWindow?: string };

export async function selectWindow(
  server: string,
  windowId: string,
): Promise<SelectWindowResult> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/select`, server),
    { method: "POST" },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function getDirectories(prefix: string): Promise<string[]> {
  const res = await deduplicatedFetch(`/api/directories?prefix=${encodeURIComponent(prefix)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.directories ?? [];
}

export async function reloadTmuxConfig(server: string): Promise<{ ok: boolean }> {
  const res = await fetch(withServer("/api/tmux/reload-config", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) await throwOnError(res);
  return { ok: true };
}

export async function initTmuxConf(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/tmux/init-conf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) await throwOnError(res);
  return { ok: true };
}

/** Trigger an on-demand refresh of BOTH server-side PR pollers — the viewer-wide
 *  collector (90s cadence) and the branch→PR refresher (30s cadence). The server
 *  responds 202 immediately and runs the refreshes on a detached goroutine; the
 *  refreshed statuses arrive via the normal SSE sessions stream (~2.5s cadence),
 *  never in this response body. The server is the single frequency choke point
 *  (coalescing + a min-interval throttle), so this is safe to over-fire — any
 *  extra call is coalesced/throttled server-side and still 202s. Best-effort /
 *  fire-and-forget: callers ignore the result. Server-independent (both pollers
 *  are global). */
/** The tri-state outcome of a manual status refresh, from the 202 body:
 *  - `started`   — a new pass began; a `status-refresh` completion event will follow.
 *  - `coalesced` — a pass is already in flight; ITS completion event will follow.
 *  - `throttled` — nothing started (within the server's min-interval); NO event will come. */
export type RefreshStatusOutcome = "started" | "coalesced" | "throttled";

export async function refreshStatus(): Promise<{ status: RefreshStatusOutcome }> {
  const res = await fetch("/api/status/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) await throwOnError(res);
  // Parse the tri-state body. Default an unknown/missing/legacy value (an older
  // daemon returns the opaque {"status":"refreshing"}) to "started" so the
  // caller still spins-until-event — the safe superset behavior.
  const body = (await res.json().catch(() => ({}))) as { status?: string };
  const status =
    body.status === "coalesced" || body.status === "throttled" ? body.status : "started";
  return { status };
}

/** Where a daemon-managed job window lives: the `watch` key of
 *  the POST /api/update and /api/restart responses. `window_id` is the tmux
 *  `@N` id — the terminal route param the client navigates to. */
export type UpdateWatchTarget = { server: string; session: string; window: string; window_id: string };

/** The resolved result of an update/restart trigger. `status` is the server's
 *  verbatim status string (`"updating"` / `"restarting"` on a fresh spawn,
 *  `"already-running"` when a live job window exists — a RESOLVED result, not
 *  an error). `watch` is absent against an old daemon that predates the
 *  job-window mechanism (tolerant parse). */
export type UpdateTriggerResult = { status: string; watch?: UpdateWatchTarget };

/** Tolerant parse of the trigger response body: a missing/malformed `watch`
 *  key resolves with `watch: undefined` (old-daemon compat); a missing status
 *  resolves as "". */
function parseUpdateTriggerResult(body: unknown): UpdateTriggerResult {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const w = (typeof b.watch === "object" && b.watch !== null ? b.watch : {}) as Record<string, unknown>;
  const watch: UpdateWatchTarget | undefined =
    typeof w.server === "string" &&
    typeof w.session === "string" &&
    typeof w.window === "string" &&
    typeof w.window_id === "string"
      ? { server: w.server, session: w.session, window: w.window, window_id: w.window_id }
      : undefined;
  return { status: typeof b.status === "string" ? b.status : "", watch };
}

/** Trigger a one-click self-upgrade of the daemon: POST /api/update. The server
 *  runs the update in a managed job window on the rk-daemon tmux server
 *  and answers 202 with a `watch` target (200 already-running
 *  when a job window is live). Best-effort from the caller's view — the ensuing
 *  daemon restart drops the SSE connection, and the reconnect's differing
 *  `version` event drives the tab reload. Rejects on a non-2xx (e.g. 409
 *  daemon-down / not-brew / no-update) so the chip can surface the failure.
 *  Server-independent (the daemon is one process). */
export async function triggerUpdate(): Promise<UpdateTriggerResult> {
  const res = await fetch("/api/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) await throwOnError(res);
  return parseUpdateTriggerResult(await res.json().catch(() => ({})));
}

/** One tool's verdict from an on-demand update check: `updateAvailable` =
 *  installed < latest; `notable` = the bump crosses the tool's notify
 *  threshold. The endpoint lists only tools with a pending update. */
export type UpdateCheckTool = {
  tool: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
  notable: boolean;
};

/** The parsed POST /api/updates/check response: the full per-tool verdict list,
 *  the composite dismissal key over the notable set, and the backend `source`
 *  the report self-identified (`"released"`/`"github"`; defensively `""` on an
 *  old daemon that omits it). */
export type UpdateCheckResult = { tools: UpdateCheckTool[]; key: string; source: string };

/** A validated wire row from POST /api/updates/check: the three identifying
 *  fields are verified present; the verdict flags are still optional (an old
 *  daemon omits them) and are normalized to booleans by the caller. */
type UpdateCheckWireTool = {
  tool: string;
  current: string;
  latest: string;
  updateAvailable?: boolean;
  notable?: boolean;
};

/** Run an on-demand update check: POST /api/updates/check. The default
 *  (source-less) call runs one inline `shll check-updates` pass against the
 *  released manifest (also converging the cached verdict + SSE slot the chip
 *  reads); passing `"github"` requests shll's GitHub release-tags backend
 *  (POST body `{"source":"github"}`) — a side-channel query the daemon answers
 *  without touching the cached verdict. Returns the fresh verdict synchronously
 *  (~1-2s) with the echoed report `source`. Rejects on a non-2xx (502 when the
 *  check itself fails — e.g. shll missing, or an older shll without `--source`
 *  support — or 409 on a dev build) with the server's error message, so the
 *  palette check commands can raise an honest error toast. */
export async function checkForUpdates(source?: "github"): Promise<UpdateCheckResult> {
  const res = await fetch("/api/updates/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(source ? { source } : {}),
  });
  if (!res.ok) await throwOnError(res);
  const body = (await res.json()) as {
    tools?: {
      tool?: string;
      current?: string;
      latest?: string;
      updateAvailable?: boolean;
      notable?: boolean;
    }[];
    key?: string;
    source?: string;
  };
  const tools: UpdateCheckTool[] = (Array.isArray(body.tools) ? body.tools : [])
    .filter(
      (t): t is UpdateCheckWireTool =>
        typeof t.tool === "string" && typeof t.current === "string" && typeof t.latest === "string",
    )
    .map((t) => ({
      tool: t.tool,
      current: t.current,
      latest: t.latest,
      updateAvailable: t.updateAvailable === true,
      notable: t.notable === true,
    }));
  return {
    tools,
    key: typeof body.key === "string" ? body.key : "",
    source: typeof body.source === "string" ? body.source : "",
  };
}

/** Force a self-upgrade regardless of the update checker's qualifying snapshot:
 *  POST /api/update with `{"force":true}`. The server skips the qualify check
 *  (but still requires a brew install) and runs the update in the managed job
 *  window, so a patch release — unreachable via the qualifying-gated
 *  `triggerUpdate()` — is installable from the web. Same result contract as
 *  `triggerUpdate()` (watch target; already-running is a resolved result).
 *  Rejects on a non-2xx (e.g. 409 not-brew). */
export async function triggerForceUpdate(): Promise<UpdateTriggerResult> {
  const res = await fetch("/api/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: true }),
  });
  if (!res.ok) await throwOnError(res);
  return parseUpdateTriggerResult(await res.json().catch(() => ({})));
}

/** Restart the daemon: POST /api/restart. The server runs `rk daemon restart`
 *  in the managed `restart` job window (no brew requirement).
 *  Best-effort — the restart drops the SSE connection, and the reconnect's
 *  differing `boot` id drives the reload guard even when the version is
 *  unchanged. Same result contract as `triggerUpdate()`. Rejects on a non-2xx
 *  (e.g. 409 on a dev build or a down daemon). Server-independent (the daemon
 *  is one process). */
export async function triggerRestart(): Promise<UpdateTriggerResult> {
  const res = await fetch("/api/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) await throwOnError(res);
  return parseUpdateTriggerResult(await res.json().catch(() => ({})));
}

export async function uploadFile(
  server: string,
  session: string,
  file: File,
  window?: string,
): Promise<{ ok: boolean; path: string }> {
  const formData = new FormData();
  formData.append("file", file);
  if (window) formData.append("window", window);

  const res = await fetch(withServer(`/api/sessions/${encodeURIComponent(session)}/upload`, server), {
    method: "POST",
    body: formData,
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

// --- Color management ---

export async function setWindowColor(
  server: string,
  windowId: string,
  color: string | null,
): Promise<{ ok: boolean }> {
  // @rk_win_color is a color-value descriptor string ("4" / "1+3") on the
  // unified /options contract; null clears it.
  return setWindowOptions(server, windowId, {
    "@rk_win_color": color,
  });
}

/** Set (or clear) the window's left-gutter marker via the unified /options
 *  contract. `marker` uses `<mode>[:<stage>]`, with manual, auto, or blocked
 *  mode and stage 1–3; null or "" clears it. Mirrors setWindowColor. */
export async function setWindowMarker(
  server: string,
  windowId: string,
  marker: string | null,
): Promise<{ ok: boolean }> {
  return setWindowOptions(server, windowId, {
    "@rk_win_marker": marker == null || marker === "" ? "" : marker,
  });
}

/** Set (or clear) the window's role via the unified /options contract.
 *  `role` is "operator"; null OR "" clears it (the server treats an empty
 *  @rk_win_role as unset). Setting "operator" clears the role from every other
 *  window on the server (radio semantics, enforced backend-side). Mirrors
 *  setWindowMarker. */
export async function setWindowRole(
  server: string,
  windowId: string,
  role: string | null,
): Promise<{ ok: boolean }> {
  return setWindowOptions(server, windowId, {
    "@rk_win_role": role == null || role === "" ? "" : role,
  });
}

/** Set (or clear) the window's flair overlay via the unified /options
 *  contract. `flair` is one of "nyan"/"naruto"/"onepiece"; null OR "" clears
 *  it (the server treats an empty @rk_win_flair as unset). Mirrors
 *  setWindowMarker. */
export async function setWindowFlair(
  server: string,
  windowId: string,
  flair: string | null,
): Promise<{ ok: boolean }> {
  return setWindowOptions(server, windowId, {
    "@rk_win_flair": flair == null || flair === "" ? "" : flair,
  });
}

/** Set (or clear) the window's one-line status note via the unified /options
 *  contract. `note` is bare free text — the server stamps the
 *  "<unix-epoch>:" prefix at write time (server owns the clock). null OR ""
 *  clears it (the server treats an empty @rk_win_note as unset). Mirrors
 *  setWindowMarker. */
export async function setWindowNote(
  server: string,
  windowId: string,
  note: string | null,
): Promise<{ ok: boolean }> {
  return setWindowOptions(server, windowId, {
    "@rk_win_note": note == null || note === "" ? "" : note,
  });
}

export async function setSessionColor(
  server: string,
  session: string,
  color: string | null,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/sessions/${encodeURIComponent(session)}/color`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** Set (or clear) the session's flair overlay. `flair` is one of
 *  "nyan"/"naruto"/"onepiece"; null/empty clears it. Mirrors setSessionColor. */
export async function setSessionFlair(
  server: string,
  session: string,
  flair: string | null,
): Promise<{ ok: boolean }> {
  const res = await fetch(
    withServer(`/api/sessions/${encodeURIComponent(session)}/flair`, server),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flair }),
    },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

// --- Server management ---

export type ServerInfo = {
  name: string;
  sessionCount: number;
  /** Total window count across the server's sessions (summed server-side from
   *  `#{session_windows}`; group copies excluded). Optional mirroring `rank` —
   *  the backend always sends it, but test fixtures may omit it. */
  windowCount?: number;
  /** User-defined display rank (@rk_srv_rank). null/undefined when unset —
   *  unranked servers sort after ranked ones within the regular class. */
  rank?: number | null;
  /** True when the server carries the @rk_srv_ephemeral scratch mark. Optional
   *  mirroring `rank`/`windowCount` — the backend always sends it, but test
   *  fixtures may omit it. Within the regular class, ephemeral servers sort
   *  after non-ephemeral ones as a tie-break below rank. */
  ephemeral?: boolean;
  /** True when the server is kill-guarded: rk-daemon by derivation, or any
   *  server carrying the @rk_srv_protected mark. Optional mirroring `ephemeral` —
   *  the backend always sends it, but test fixtures may omit it. */
  protected?: boolean;
  /** True when the server is rk-managed: rk-daemon by derivation, or any
   *  server carrying the @rk_srv_managed provenance mark (rk-born or adopted).
   *  Optional mirroring `protected` — an old backend omitting the field must
   *  render NO external treatment, so consumers gate on `managed === false`,
   *  never on absence. */
  managed?: boolean;
};

/** The tmux server socket hosting the run-kit daemon itself (infrastructure,
 *  not a workspace). Mirrors the backend `ServerSocket` constant
 *  (app/backend/internal/daemon/daemon.go). */
export const DAEMON_SERVER = "rk-daemon";
// Mirrors backend IsTestServerName (app/backend/internal/tmux/tmux.go:1342) —
// the one frontend home of the "rk-test-" literal.
const TEST_SERVER_PREFIX = "rk-test-";

/** True for infrastructure servers (the daemon socket and any test socket),
 *  which are de-emphasized and sorted last in every server list. */
export function isInfraServer(name: string): boolean {
  return name === DAEMON_SERVER || name.startsWith(TEST_SERVER_PREFIX);
}

/** True when the server is external (not started/managed by run-kit). Gates on
 *  `managed === false` exactly — an absent field (old backend mid-deploy) is
 *  unknown, NOT external, and renders no treatment. */
export function isExternalServer(info: ServerInfo | undefined): boolean {
  return info?.managed === false;
}

/** Sort comparator: regular servers first (alphabetical), then infrastructure
 *  servers (alphabetical within their class). Plain lexicographic (not
 *  localeCompare) to mirror the backend's `sort.Strings` byte order within each
 *  class, keeping the regular-server segment byte-identical to today. */
export function compareServers(a: ServerInfo, b: ServerInfo): number {
  const ai = isInfraServer(a.name);
  const bi = isInfraServer(b.name);
  if (ai !== bi) return ai ? 1 : -1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Rank-aware sort comparator. Effective key: (infra-class, rank, ephemeral, name).
 *
 *  Infra servers (`isInfraServer`) stay pinned last as a class and IGNORE rank
 *  and ephemeral entirely (their intra-class order is byte-alphabetical,
 *  unchanged). Within the regular class: ranked servers sort by rank
 *  ascending; a ranked server sorts before any unranked one; at equal rank
 *  (or both unranked), ephemeral servers sink below non-ephemeral ones, then
 *  byte-order name. Rank outranks ephemeral — a deliberately dragged
 *  ephemeral tile keeps its placement; scratch servers are agent-created and
 *  unranked in practice, so they still sink. This wraps `compareServers` so
 *  the infra-last + byte-order semantics (and their tests) are preserved
 *  verbatim — rank and ephemeral are secondary keys inserted only inside the
 *  regular class. An all-regular-unranked-unmarked list is byte-alphabetical,
 *  identical to `compareServers`. */
export function compareServersRanked(a: ServerInfo, b: ServerInfo): number {
  const ai = isInfraServer(a.name);
  const bi = isInfraServer(b.name);
  // Cross-class or both-infra: defer entirely to compareServers (infra ignore
  // rank/ephemeral; the class pin and byte-order intra-infra ordering are
  // unchanged).
  if (ai !== bi || (ai && bi)) return compareServers(a, b);
  // Both regular: rank is the primary key.
  const ar = a.rank ?? null;
  const br = b.rank ?? null;
  if (ar !== br) {
    if (ar === null) return 1; // unranked sorts after ranked
    if (br === null) return -1;
    return ar - br;
  }
  // Same rank (both null, or an unlikely duplicate rank): ephemeral sinks.
  const ae = a.ephemeral ?? false;
  const be = b.ephemeral ?? false;
  if (ae !== be) return ae ? 1 : -1;
  // Byte-order name.
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export async function listServers(): Promise<ServerInfo[]> {
  const res = await deduplicatedFetch("/api/servers");
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function createServer(name: string): Promise<{ ok: boolean }> {
  const res = await fetch("/api/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export async function killServer(name: string, force = false): Promise<{ ok: boolean }> {
  const res = await fetch("/api/servers/kill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, force }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** Set or clear the @rk_srv_protected mark on a server — the Protect/Unprotect
 *  toggle. rk-daemon is rejected backend-side (400: its protection is derived,
 *  not togglable). The backend wakes the SSE hub so covered clients repaint
 *  without waiting for the safety poll. */
export async function setServerProtected(
  name: string,
  protected_: boolean,
): Promise<{ ok: boolean }> {
  const res = await fetch("/api/servers/protect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, protected: protected_ }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** Adopt an external (unmarked) server into run-kit management — the backend
 *  stamps @rk_srv_managed and sources the managed conf (rolling back the stamp
 *  when the reload fails). Idempotent: an already-managed target returns 200
 *  {"status":"already-managed"}; there is no un-adopt verb. The backend wakes
 *  the SSE hub so covered clients repaint without waiting for the safety
 *  poll. */
export async function adoptServer(name: string): Promise<{ status: string }> {
  const res = await fetch("/api/servers/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** Persist the user-defined server display order. The backend writes rank i to
 *  the i-th listed server and broadcasts a server-global `event: server-order`.
 *  Server-independent (like listServers/createServer/killServer) — the order
 *  spans the whole /api/servers list, not one server. */
export async function setServerOrder(order: string[]): Promise<void> {
  const res = await fetch("/api/servers/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
  if (!res.ok) await throwOnError(res);
}

// --- Host recovery (reboot-orphaned snapshot offers) ---

/** One recorded window inside a recovery offer's stored layout tree. */
export type RecoveryWindow = {
  index: number;
  name: string;
  paneCount: number;
  /** Former per-pane commands — display-only; restore semantics are server-side. */
  commands: string[];
  /** True when any recorded pane command was an agent (`claude`) — a
   *  display-only tag; the per-window resume affordance is out of scope. */
  resumable: boolean;
};

/** One recorded session inside a recovery offer. `color` is the raw
 *  @rk_ses_color descriptor ("4" / "1+3"), absent when unset. */
export type RecoverySession = {
  name: string;
  color?: string;
  windows: RecoveryWindow[];
};

/** A restorable snapshot offer: a server that died with the host (reboot) and
 *  left a live-latest layout snapshot on disk. Carries the full layout tree
 *  inline so the row expansion needs no second request. */
export type RecoveryOffer = {
  server: string;
  /** RFC3339 snapshot timestamp — the row's "last seen" age. */
  takenAt: string;
  sessionCount: number;
  windowCount: number;
  sessions: RecoverySession[];
};

/** The restore engine's report body (recreated sessions/windows, skipped
 *  items, notes, former commands). The frontend only gates on the HTTP status
 *  — no individual field is read. */
export type RecoveryRestoreReport = Record<string, unknown>;

/** List restorable snapshot offers. Server-global — no `server` param. */
export async function getRecoveryOffers(): Promise<RecoveryOffer[]> {
  const res = await deduplicatedFetch("/api/recovery");
  if (!res.ok) await throwOnError(res);
  const data = (await res.json()) as { offers?: RecoveryOffer[] };
  return data.offers ?? [];
}

/** Restore one offered server from its snapshot. Body-addressed (mirrors
 *  POST /api/servers/kill), synchronous server-side; rejects with the
 *  engine's refusal message on a non-ok status (e.g. server already alive). */
export async function restoreRecoveryServer(server: string): Promise<RecoveryRestoreReport> {
  const res = await fetch("/api/recovery/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** Dismiss one offer (tombstones the snapshot server-side; idempotent). */
export async function dismissRecoveryServer(server: string): Promise<{ ok: boolean }> {
  const res = await fetch("/api/recovery/dismiss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

export interface Keybinding {
  key: string;
  table: string;
  command: string;
  label: string;
}

export async function getKeybindings(server: string): Promise<Keybinding[]> {
  const res = await deduplicatedFetch(withServer("/api/keybindings", server));
  if (!res.ok) await throwOnError(res);
  return res.json();
}

// --- Settings (global, not per-server) ---
// One registry-driven endpoint pair serves every settings key: GET returns
// registry metadata + current values, POST is a partial merge (present keys
// set, null unsets). All getters share one deduplicated GET so the mount-time
// burst collapses into a single request; setters post only the keys they own.

/** One registry row as served by GET /api/settings. `options` is present only
 *  on enum kinds (the entry's legal values, in display order). */
export interface SettingsEntry {
  key: string;
  kind: string;
  default: string;
  description: string;
  category: string;
  ui: boolean;
  live: boolean;
  options?: string[];
  value: unknown;
}

export async function getSettingsEntries(): Promise<SettingsEntry[]> {
  const res = await deduplicatedFetch("/api/settings");
  if (!res.ok) await throwOnError(res);
  const data: { settings: SettingsEntry[] } = await res.json();
  return data.settings;
}

function settingValue(entries: SettingsEntry[], key: string): unknown {
  return entries.find((e) => e.key === key)?.value;
}

function stringSetting(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStringSetting(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapSetting(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function postSettings(patch: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) await throwOnError(res);
}

// --- Theme settings ---

export async function getThemePreference(): Promise<{
  theme: string;
  themeDark: string;
  themeLight: string;
}> {
  const entries = await getSettingsEntries();
  return {
    theme: stringSetting(settingValue(entries, "theme")) || "system",
    themeDark: stringSetting(settingValue(entries, "theme_dark")),
    themeLight: stringSetting(settingValue(entries, "theme_light")),
  };
}

export async function setThemePreference(prefs: {
  theme?: string;
  themeDark?: string;
  themeLight?: string;
}): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (prefs.theme !== undefined) patch.theme = prefs.theme;
  if (prefs.themeDark !== undefined) patch.theme_dark = prefs.themeDark;
  if (prefs.themeLight !== undefined) patch.theme_light = prefs.themeLight;
  if (Object.keys(patch).length === 0) return;
  await postSettings(patch);
}

// --- Server color settings ---

export async function getServerColor(server: string): Promise<string | null> {
  const entries = await getSettingsEntries();
  return mapSetting(settingValue(entries, "server_colors"))[server] ?? null;
}

export async function getAllServerColors(): Promise<Record<string, string>> {
  const entries = await getSettingsEntries();
  return mapSetting(settingValue(entries, "server_colors"));
}

export async function setServerColor(server: string, color: string | null): Promise<void> {
  await postSettings({ server_colors: { [server]: color } });
}

// --- Server flair settings (a server→flair map on the instance-global settings store) ---

export async function getAllServerFlairs(): Promise<Record<string, string>> {
  const entries = await getSettingsEntries();
  return mapSetting(settingValue(entries, "server_flairs"));
}

export async function setServerFlair(server: string, flair: string | null): Promise<void> {
  await postSettings({ server_flairs: { [server]: flair } });
}

// --- Instance accent color (per-instance "host color", scalar) ---

/** The explicit instance accent color descriptor ("4" / "1+3"), or null when
 *  unset (no accent — there is no derived default; resolution is explicit
 *  setting → localStorage paint echo → none, see instance-accent.ts). */
export async function getInstanceColor(): Promise<string | null> {
  const entries = await getSettingsEntries();
  return nullableStringSetting(settingValue(entries, "instance_color"));
}

export async function setInstanceColor(color: string | null): Promise<void> {
  await postSettings({ instance_color: color });
}

// --- SSH host + instance name (host-scoped scalar settings) ---

/** The stored SSH destination SETTING (alias or user@host), or null when
 *  unset. This is the raw setting the settings dialog edits — the EFFECTIVE
 *  value (the same setting; the sole source) rides getHealth().sshHost. */
export async function getSSHHost(): Promise<string | null> {
  const entries = await getSettingsEntries();
  return nullableStringSetting(settingValue(entries, "ssh_host"));
}

export async function setSSHHost(host: string | null): Promise<void> {
  await postSettings({ ssh_host: host });
}

/** The stored instance display-name override, or null when unset (display
 *  surfaces then fall back to the health-reported hostname). */
export async function getInstanceName(): Promise<string | null> {
  const entries = await getSettingsEntries();
  return nullableStringSetting(settingValue(entries, "instance_name"));
}

export async function setInstanceName(name: string | null): Promise<void> {
  await postSettings({ instance_name: name });
}

// --- Web Push ---

/** Fetch the server's VAPID public key (base64url) for pushManager.subscribe. */
export async function getVapidPublicKey(): Promise<string> {
  const res = await deduplicatedFetch("/api/push/vapid-public-key");
  if (!res.ok) await throwOnError(res);
  const data: { key: string } = await res.json();
  return data.key;
}

/** POST a browser PushSubscription (its JSON form) to the server's store. */
export async function subscribePush(subscription: PushSubscriptionJSON): Promise<void> {
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  });
  if (!res.ok) await throwOnError(res);
}

// --- Riff (web-UI agent spawn) ---

/** A riff preset summary for the spawn dialog's dropdown, mirroring the backend
 *  `GET /api/riff/presets` shape. `layout` is the empty string when unset. */
export type RiffPreset = {
  name: string;
  layout: string;
  paneCount: number;
};

/** The response of a successful spawn — enough to navigate to the new window. */
export type RiffSpawnResult = {
  server: string;
  session: string;
  window: string;
  windowId: string;
};

/** Where a spawn's window is rooted: a fresh isolated worktree (default) or the
 *  session's existing checkout (no worktree created). Mirrors the mockup-v2
 *  `where` body field. */
export type RiffWhere = "worktree" | "checkout";

/** The spawn dialog's preflight fetch — presets + the available agent tiers,
 *  both from the single `GET /api/riff/presets` (mockup-v2). `tiers` is always
 *  non-empty (fab-kit built-ins ∪ the repo's `agent.tiers`, `default` first). */
export type RiffPreflight = {
  presets: RiffPreset[];
  tiers: string[];
};

/** The mockup-v2 spawn-shaping options. All optional and additive over the
 *  shipped `{task, preset}` — omitted fields fall back to the backend defaults
 *  (worktree isolation, auto-named worktree, default tier). */
export type SpawnRiffOptions = {
  task?: string;
  preset?: string;
  where?: RiffWhere;
  worktreeName?: string;
  tier?: string;
};

/** Spawn a riff agent window in `session`'s repo. `opts.task` (optional) becomes
 *  the agent's boot task (auto-submits); an empty task spawns a blank agent
 *  session. `opts.preset` selects a riff preset; `opts.where` chooses worktree
 *  (default) vs. the existing checkout; `opts.worktreeName` names the worktree
 *  (worktree mode only); `opts.tier` picks the fab agent tier. Each field is
 *  omitted from the POST body when unset/default, so a defaults-only call is
 *  byte-identical to the shipped two-field path. On success the caller navigates
 *  to `/$server/$windowId`. Throws on a non-ok response (a 400 carries a
 *  human-readable message, e.g. non-repo cwd). */
export async function spawnRiff(
  server: string,
  session: string,
  opts: SpawnRiffOptions = {},
): Promise<RiffSpawnResult> {
  const body: Record<string, string> = { session };
  if (opts.task) body.task = opts.task;
  if (opts.preset) body.preset = opts.preset;
  // "worktree" is the backend default — omit it to keep the shipped path's body.
  if (opts.where && opts.where !== "worktree") body.where = opts.where;
  if (opts.worktreeName) body.worktreeName = opts.worktreeName;
  // "default" resolves the same tier as an omitted value — omit it so the
  // defaults-only body matches the shipped path exactly.
  if (opts.tier && opts.tier !== "default") body.tier = opts.tier;
  const res = await fetch(withServer("/api/riff", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** Fork the window's agent conversation into a NEW window in the SAME session
 *  and directory. Window-keyed and body-less: the backend derives
 *  the session, the Claude session uuid, the directory, and the new window's name
 *  server-side from `windowId` alone — the client never supplies a session ref.
 *  Returns riff's spawn result, so the caller navigates exactly as it does after
 *  a spawn. Throws on a non-ok response: `404` when the window has no forkable
 *  claude agent session, `400` when its directory is not inside a git repo. */
export async function forkWindow(server: string, windowId: string): Promise<RiffSpawnResult> {
  const res = await fetch(
    withServer(`/api/windows/${encodeURIComponent(windowId)}/fork`, server),
    { method: "POST" },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** Fetch the spawn dialog's preflight for `session`'s repo: the riff presets
 *  (YAML source order; [] when none) and the available agent tiers (built-ins ∪
 *  repo config, `default` first). Throws on a non-ok response (e.g. 400 for a
 *  non-repo cwd); the dialog treats a failure as "no presets, tier `default`
 *  only" (it cannot enumerate the repo's tiers without this fetch) and still
 *  allows a task-only spawn. */
export async function getRiffPresets(
  server: string,
  session: string,
): Promise<RiffPreflight> {
  const res = await deduplicatedFetch(
    withServer(`/api/riff/presets?session=${encodeURIComponent(session)}`, server),
  );
  if (!res.ok) await throwOnError(res);
  const data: { presets?: RiffPreset[]; tiers?: string[] } = await res.json();
  return { presets: data.presets ?? [], tiers: data.tiers ?? [] };
}

// --- Cron (the operator clock: entries + derived fire facts + delivery log) ---

/** One cron schedule on the wire (the on-disk YAML's kind + params, camelCase).
 *  Which param fields are populated depends on `kind`: every → `interval`,
 *  backoff → `min`/`max`, cron → `expr`. */
export interface CronSchedule {
  kind: string;
  interval?: string;
  min?: string;
  max?: string;
  expr?: string;
}

/** Optional wake-on-event clause (`wake_on` in the entry file). */
export interface CronWakeOn {
  event: string;
  scope?: string;
  debounce?: string;
}

/** One cron entry as GET /api/cron serves it: the intent fields plus the
 *  derived facts. `lastFired` is unix seconds, 0 = never; `nextFire` is
 *  present only when the evaluator computed one (absent = "unknown"). */
export interface CronEntry {
  id: string;
  name?: string;
  schedule: CronSchedule;
  wakeOn?: CronWakeOn;
  target: { kind: string; role?: string; session?: string; pane?: string };
  payload: string;
  deliver?: string;
  ifAbsent?: string;
  /** Respawn argv for `ifAbsent: "respawn"` — present only when stored. */
  respawn?: string[];
  pinned?: boolean;
  /** Effective mute state — the stored flag OR an unexpired lease, resolved
   *  server-side. Consumers key dimming on this without knowing about leases. */
  muted?: boolean;
  /** Mute-lease expiry (unix seconds), present only while a lease is stored —
   *  check it against the fetch time: an expired value means the entry is
   *  already unmuted (the server reports `muted: false` then). */
  mutedUntil?: number;
  lastFired: number;
  nextFire?: number;
  rung?: number;
  orphaned?: boolean;
  /** Orphan facts, present only while `orphaned` is true and the evaluator
   *  derived them: `orphanedSince` is when the target went absent (unix
   *  seconds), `expiresAt` is when the orphan TTL reaps the entry. */
  orphanedSince?: number;
  expiresAt?: number;
}

/** One delivery-log line from GET /api/cron's `deliveries` array
 *  (most-recent-first, capped server-side). `name` is joined from the entry
 *  when it still exists — empty for a since-deleted entry. */
export interface CronDelivery {
  ts: number;
  entry: string;
  name?: string;
  target: string;
  reason: string;
  outcome: string;
}

export interface CronListResponse {
  entries: CronEntry[];
  deliveries: CronDelivery[];
}

/** GET /api/cron?server=<slug> — the one read endpoint for everything cron on
 *  a server (entries + derived fire facts + recent deliveries). Tolerant
 *  parse: absent arrays read as empty. */
export async function getCron(server: string): Promise<CronListResponse> {
  const res = await deduplicatedFetch(withServer("/api/cron", server));
  if (!res.ok) await throwOnError(res);
  const data = (await res.json()) as { entries?: CronEntry[]; deliveries?: CronDelivery[] };
  return { entries: data.entries ?? [], deliveries: data.deliveries ?? [] };
}

/** Body for POST /api/cron/create — the `rk cron add` schema fields in
 *  camelCase. `target` defaults server-side only through validation, so the
 *  caller always sends one (the dialog targets role "operator"). */
export interface CronCreateBody {
  name?: string;
  schedule: CronSchedule;
  target: { kind: string; role?: string; session?: string; pane?: string };
  payload: string;
  deliver?: string;
  ifAbsent?: string;
  pinned?: boolean;
}

/** POST /api/cron/create — 201 with the created entry (assigned id included);
 *  a validation failure rejects with the server's 400 error text. */
export async function createCron(server: string, body: CronCreateBody): Promise<CronEntry> {
  const res = await fetch(withServer("/api/cron/create", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** POST /api/cron/mute — `{id, muted}`, plus `for` when `forDuration` is
 *  given: a Go duration string setting a mute lease that expires on its own.
 *  Absent keeps the flag-only behavior (also the shape for unmute, which
 *  clears any stored lease server-side). 404 on an unknown id. */
export async function muteCron(
  server: string,
  id: string,
  muted: boolean,
  forDuration?: string,
): Promise<{ ok: boolean }> {
  const body: { id: string; muted: boolean; for?: string } = { id, muted };
  if (forDuration !== undefined) body.for = forDuration;
  const res = await fetch(withServer("/api/cron/mute", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** Body for POST /api/cron/edit — only the fields being changed, alongside
 *  `id`. `respawn: []` clears the stored argv. */
export interface CronEditBody {
  id: string;
  name?: string;
  schedule?: CronSchedule;
  deliver?: string;
  ifAbsent?: string;
  respawn?: string[];
}

/** POST /api/cron/edit — 200 with the updated entry; 400 carries the server's
 *  validation text; 409 when a cron tick is in progress (retryable). */
export async function editCron(server: string, body: CronEditBody): Promise<CronEntry> {
  const res = await fetch(withServer("/api/cron/edit", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** POST /api/cron/pin — `{id, pinned}`, mirroring mute's contract exactly.
 *  404 on an unknown id. */
export async function pinCron(
  server: string,
  id: string,
  pinned: boolean,
): Promise<{ ok: boolean }> {
  const res = await fetch(withServer("/api/cron/pin", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, pinned }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** POST /api/cron/delete — `{id}`. 404 on an unknown id. */
export async function deleteCron(server: string, id: string): Promise<{ ok: boolean }> {
  const res = await fetch(withServer("/api/cron/delete", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

// ── the `review` surface (docs/specs/pr-review.md § R4) ─────────────────────
//
// Reads GET, every mutation POST (Constitution IX). The file LIST and the file
// BODY are separate reads on purpose: a 200-file PR renders its list without
// tokenizing any of them.

/** GET /api/diff — the working-directory tile's mount payload. One read of the
 *  tree: two local git calls, ~50 ms, no cache behind it. */
export async function fetchWorkingDiff(
  server: string,
  windowId: string,
  signal?: AbortSignal,
): Promise<WorkingSnapshot> {
  const res = await fetch(
    withServer(`/api/diff?window=${encodeURIComponent(windowId)}`, server),
    { signal },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** GET /api/diff/digest — one fingerprint of everything the tile renders.
 *
 *  The tile polls this instead of the whole document: ~70 bytes against a
 *  megabyte, so a tree nobody is touching costs almost nothing per tick. */
export async function fetchWorkingDiffDigest(
  server: string,
  windowId: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(
    withServer(`/api/diff/digest?window=${encodeURIComponent(windowId)}`, server),
    { signal },
  );
  if (!res.ok) await throwOnError(res);
  const body = (await res.json()) as { digest: string };
  return body.digest;
}

/** GET /api/diff/file — one file's rows, with token spans. */
export async function fetchWorkingDiffFile(
  server: string,
  windowId: string,
  path: string,
  signal?: AbortSignal,
): Promise<ReviewFileBody> {
  const params = new URLSearchParams({ window: windowId, path });
  const res = await fetch(withServer(`/api/diff/file?${params.toString()}`, server), { signal });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** GET /api/pr/review — the tile's mount payload: file list, threads, viewer
 *  login and the listener arm. Carries no file body. */
export async function fetchPRReview(
  server: string,
  windowId: string,
  signal?: AbortSignal,
): Promise<ReviewDocument> {
  const res = await fetch(
    withServer(`/api/pr/review?window=${encodeURIComponent(windowId)}`, server),
    { signal },
  );
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/**
 * GET /api/pr/review/file — one file's rows as per-line token spans.
 *
 * Without `start` the response carries the file's PATCH rows (its hunks); with
 * it, post-image lines `start..start+count-1` as context rows (the `↕ All N
 * lines` / `↑ 5 lines` expanders), served from the same cached blob the lexer
 * uses.
 */
export async function fetchPRReviewFile(
  server: string,
  windowId: string,
  path: string,
  range?: { start: number; count: number },
): Promise<ReviewFileBody> {
  const params = new URLSearchParams({ window: windowId, path });
  if (range) {
    params.set("start", String(range.start));
    params.set("count", String(range.count));
  }
  const res = await fetch(withServer(`/api/pr/review/file?${params.toString()}`, server));
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** A new line-anchored comment, or — with `replyTo` — a reply on an existing
 *  thread. `mode` is "single" (posts now; the only mode the listener can
 *  dispatch on) or "review" (appends to the viewer's pending review, invisible
 *  to gh until submitted). */
export interface PRReviewCommentRequest {
  window: string;
  body: string;
  replyTo?: number;
  path?: string;
  line?: number;
  startLine?: number;
  side?: ReviewSide;
  mode?: "single" | "review";
}

/** POST /api/pr/review/comment. */
export async function postPRReviewComment(
  server: string,
  request: PRReviewCommentRequest,
): Promise<{ status: string }> {
  const res = await fetch(withServer("/api/pr/review/comment", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** POST /api/pr/review/thread — resolve / unresolve. */
export async function postPRReviewThread(
  server: string,
  windowId: string,
  threadId: string,
  resolved: boolean,
): Promise<{ resolved: boolean }> {
  const res = await fetch(withServer("/api/pr/review/thread", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ window: windowId, threadId, resolved }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** POST /api/pr/review/listen — arm / disarm the comment listener. The arm is
 *  the `@rk_win_pr_listen` window option, so every viewer sees the flip. */
export async function postPRReviewListen(
  server: string,
  windowId: string,
  listening: boolean,
): Promise<{ listening: boolean }> {
  const res = await fetch(withServer("/api/pr/review/listen", server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ window: windowId, listening }),
  });
  if (!res.ok) await throwOnError(res);
  return res.json();
}

/** POST /api/pr/review/refresh — the same tri-state 202 as
 *  `/api/status/refresh`: the body reports the fate, never completion. */
export async function postPRReviewRefresh(
  server: string,
  windowId: string,
): Promise<{ status: RefreshStatusOutcome }> {
  const res = await fetch(
    withServer(`/api/pr/review/refresh?window=${encodeURIComponent(windowId)}`, server),
    { method: "POST" },
  );
  if (!res.ok) await throwOnError(res);
  const body = (await res.json().catch(() => ({}))) as { status?: string };
  const status =
    body.status === "coalesced" || body.status === "throttled" ? body.status : "started";
  return { status };
}
