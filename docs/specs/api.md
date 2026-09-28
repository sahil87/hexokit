# HexoKit API Specification

> Defines the HTTP, SSE, and WebSocket surface for HexoKit's Go backend.
> This is the **target spec** — the source of truth for what the API should be.
> Implementation and tests conform to this document, not the other way around.

---

## Design Principles

1. **POST for all mutations** — every write operation uses POST. Intent communicated by URL path, not HTTP method. Simplifies the client, avoids CORS preflight for non-simple methods. One documented exception: `/mcp` (§ MCP) is bound by the MCP streamable-HTTP transport to `POST` + `GET` + `DELETE` on a single path. The exception is transport-scoped and does not extend to `/api/*`.
2. **GET for all reads** — session listing, directory autocomplete, SSE stream, health check.
3. **Consistent error shape** — every error returns `{ "error": "<message>" }` with an appropriate HTTP status.
4. **Validated at the boundary** — all user input validated before reaching tmux; invalid input never touches a subprocess.
5. **No database** — all state derived from tmux + filesystem at request time.
6. **Single port** — API, SSE, WebSocket relay, and SPA static files served on one port.

---

## Base Configuration

The override order is `code default < config.yaml < env < CLI flag`. Env forms exist only for the deployment-bootstrap keys below; per-instance preference keys (the settings registry) resolve `defaults → ~/.config/hexokit/config.yaml` only — no env form, no CLI flag — with one exception: the daemon port is also a config.yaml key (`port` in the settings registry, `ui: false`) that keeps its `RK_PORT` env form, so an install can pin the port durably while env still wins. The config root `~/.config/hexokit/` is fixed: it is built from `$HOME` alone and never consults `XDG_CONFIG_HOME`.

| Setting | Default | Override order |
|---------|---------|----------------|
| Port | `6123` | defaults → config.yaml `port` → env `RK_PORT` |
| Host | `127.0.0.1` | defaults → env `RK_HOST` |
| Code-server port | resolved daemon port + 2 | defaults → env `RK_CODE_SERVER_PORT` |

---

## Middleware

Applied in order to all `/api/*` routes:

1. **CORS** — allow all origins, methods `GET POST OPTIONS`, headers `Accept Authorization Content-Type`, no credentials, 300s max-age
2. **Request logger** — structured log to stderr
3. **Panic recovery** — catches panics, returns 500

---

## Endpoints

### Health

#### `GET /api/health`

Supervisor health check. No authentication.

**Response** `200`:
```json
{ "status": "ok", "tunnel": 3001 }
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | Always `"ok"` |
| `tunnel` | `number` | The daemon's listen port, advertised so the desktop shell can self-test the tunnel against the host's own listen port (§ Tunnel). Older daemons omit the field; its absence reads as no tunnel capability |

---

### Sessions

A session maps 1:1 to a tmux session. Each session is a "project".

#### `GET /api/sessions`

Returns all tmux sessions with their windows, enriched with fab-kit state where detected.

**Response** `200`:
```json
[
  {
    "name": "run-kit",
    "windows": [
      {
        "index": 0,
        "name": "main",
        "worktreePath": "/Users/sahil/code/sahil87/run-kit",
        "activity": "active",
        "isActiveWindow": true,
        "fabChange": "260312-jz77-scaffold-app-structure",
        "fabStage": "review-pr",
        "fabDisplayState": "done"
      }
    ]
  }
]
```

**Window fields:**

| Field | Type | Description |
|-------|------|-------------|
| `index` | `int` | 0-based tmux window index |
| `name` | `string` | Window name |
| `worktreePath` | `string` | Absolute path from `pane_current_path` |
| `activity` | `"active" \| "idle"` | Active if tmux activity within last 10 seconds |
| `isActiveWindow` | `bool` | Whether this is the currently selected tmux window |
| `fabChange` | `string?` | Active change name from `.fab-status.yaml`, omitted if no active change |
| `fabStage` | `string?` | Current active stage (first `active` entry in `.fab-status.yaml` `progress` map), omitted if no active change |
| `fabDisplayState` | `string?` | Pipeline state of the displayed stage from `fab pane map` `display_state` — one of `active`, `ready`, `done`, `failed`, `pending`, `skipped`; omitted when fab reports `null` or the field is absent (fab < 2.1.7) |

**Behavior:**
- Filters out byobu session-group copies (keep where `name == group` or `grouped == 0`)
- Fab enrichment is per-session (not per-window): reads `.fab-status.yaml` once from the project root (window 0's `pane_current_path`). All windows in a session share the same fab state.
- Project root derived from window 0's `pane_current_path`

#### `POST /api/sessions`

Create a new tmux session.

**Request:**
```json
{
  "name": "my-project",
  "cwd": "~/code/my-project"
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | `string` | yes | Non-empty, max 128 chars, no shell metacharacters (`;& \| \` $ (){}[]<>!#*?`), no colons, no periods, no whitespace control chars |
| `cwd` | `string` | no | Max 1024 chars, must resolve under `$HOME`, supports `~` expansion. Defaults to server CWD if omitted. |

**Response** `201`:
```json
{ "ok": true }
```

**Errors:**
- `400` — validation failure
- `500` — tmux command failed

#### `POST /api/sessions/:session/kill`

Kill an entire tmux session and all its windows.

**URL params:**

| Param | Validation |
|-------|------------|
| `session` | Same name validation as create |

**Response** `200`:
```json
{ "ok": true }
```

**Errors:**
- `400` — invalid session name
- `500` — tmux command failed

---

### Windows

Windows live within a session. They map to tmux windows.

#### `POST /api/sessions/:session/windows`

Create a new window in a session.

**Request:**
```json
{
  "name": "feature-branch",
  "cwd": "~/code/my-project"
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | `string` | no | When present and non-empty, same rules as session name. Omitted or empty ⇒ tmux auto-names the window to its folder basename via `automatic-rename-format '#{b:pane_current_path}'` (see below). |
| `cwd` | `string` | no | Same rules as session CWD |
| `rkType` | `string` | no | Marks an rk-managed window (e.g. `iframe`). When present, `name` becomes **required** (a non-empty validated name) — see Errors. |
| `rkUrl` | `string` | no | Target URL for an `rkType` window |

**Behavior:**
- **Name is optional.** An omitted or empty `name` (with no `rkType`) creates the window without `-n`, so tmux applies the global `automatic-rename-format '#{b:pane_current_path}'` and the window displays — and live-updates — its pane's folder basename. A non-empty `name` is validated and pins the window (automatic-rename off).
- **`rkType`-present requires a name.** When `rkType` is set, an empty/omitted `name` is rejected (400) so an rk-managed window is never pinned to an empty name with automatic-rename disabled.

**Response** `201`:
```json
{ "ok": true }
```

**Errors:**
- `400` — non-empty `name` fails validation, or `rkType` present with an empty/omitted `name`
- `500` — tmux command failed

#### `POST /api/sessions/:session/windows/:index/kill`

Kill a specific window.

**URL params:**

| Param | Type | Validation |
|-------|------|------------|
| `session` | `string` | Name validation |
| `index` | `int` | Non-negative integer |

**Response** `200`:
```json
{ "ok": true }
```

#### `POST /api/sessions/:session/windows/:index/rename`

Rename a window.

**Request:**
```json
{
  "name": "new-name"
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | `string` | yes | Same rules as session name |

**Response** `200`:
```json
{ "ok": true }
```

#### `POST /api/sessions/:session/windows/:index/keys`

Send keystrokes to a window.

**Request:**
```json
{
  "keys": "echo hello"
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `keys` | `string` | yes | Non-empty after trim |

**Behavior:**
- Sends via `tmux send-keys -t {session}:{index} {keys} Enter`

**Response** `200`:
```json
{ "ok": true }
```

#### `POST /api/windows/:windowId/send`

Send a message into a window's resolved pane — the compose strip's single delivery door. The client names an **intent** (`mode`), never a mechanism: the handler picks the tmux strategy (bracketed paste lands multi-line text as one literal block; raw relay bytes carrying embedded newlines collapse in Claude Code's input). By default no agent session is required on the window.

**Request:**
```json
{
  "text": "line one\nline two",
  "mode": "submit",
  "target": "agent"
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `text` | `string` | yes (except `mode:"enter"`) | Control bytes stripped (`inject.Sanitize`) **before** the check; non-empty after trim |
| `mode` | `string` | yes | `submit` (paste + probed Enter) · `insert-line` (paste, Enter withheld) · `raw` (unbracketed LF-preserving paste) · `enter` (one bare Enter, no text) |
| `target` | `string` | no | Absent = the window's **active** pane; `"agent"` = the window's agent pane via the `@rk_pane_agent_session` rollup, failing closed with `404` when no pane carries an agent session (the selection broadcast's mode); anything else `400` |

**Behavior:**
- Resolves the target pane server-side from one session snapshot (active pane by default; agent pane for `target:"agent"`)
- Drives the shared `internal/inject` engine: baseline `capture-pane` → `set-buffer -b rk-agent-send -- <text>` → `paste-buffer -d -p -t <pane>` → novelty echo probe → `send-keys Enter` only on probe success **and** `mode:"submit"`
- `-p` brackets only when the pane's application requested bracketed paste; a plain shell receives raw bytes
- One shared 4s deadline bounds the whole sequence; per-`(server, pane)` serialization across all modes

**Responses:**
- `200` `{ "ok": true }`
- `400` invalid window id · invalid JSON · unknown mode/target · empty text after sanitization
- `404` window not found (or no panes) · `target:"agent"` with no chat-carrying pane
- `409` structured injection outcomes (`probe_failure` — Enter withheld, text staged; `staged_send_failure`; `submit_unverified`) — retrying would duplicate the staged text
- `500` session fetch or tmux subprocess failure

#### `POST /api/operator/start`

Start the server's operator — the UI door (the quake terminal's Start operator button, the `Operator: Start operator` palette entry) onto the same launch the cron daemon's respawn path runs: the daemon execs its OWN binary (the `resolveSelfPathFn` seam — never a PATH-resolved `rk`) as `rk operator -L <server> --json`, which owns creation, role-stamping, singleton probing, agent resolution, and kickoff delivery. Server scope rides the `?server=` query (`serverFromRequest`).

**Request body** (optional): `{ "window": "@7" }` — the id of the window the user is viewing (the Terminal route's window, sent only when its server is the one being started). `{}` or an empty body means "no viewed window". The body carries ONLY the window identity — never a filesystem path.

**Behavior:**
- One `FetchSessions` pre-check: an existing `role === "operator"` window short-circuits with `409 operator_exists` (the UI hides its Start affordances when an operator exists; this is the race backstop).
- With a `window` in the body, the daemon looks it up in the already-fetched sessions slice (no second fetch), takes its active-pane cwd (`worktreePath`, from `#{pane_current_path}`), collapses it to the main checkout via `gitinfo.MainWorktreeRoot` (a linked worktree maps to `<repo>`; a non-repo cwd is used verbatim — deterministic, it is where the user is), and appends `--dir <derived>` to the argv: `[rk, operator, -L, server, --dir, <derived>, --json]`. The derived directory must pass an absolute/exists/is-dir pre-check before exec.
- A well-formed `window` that is not on the server (closed between the click and the request), an empty pane cwd, or a derived directory failing the pre-check degrades to the no-window argv — never a failed start.
- With no `window`, the argv is unchanged and the CLI's own rule decides: the server's last recorded operator launch directory (`@rk_srv_operator_root`, stamped by `rk operator` on every successful create), else the home directory.
- The exec runs under a process context DETACHED from the request (90s — the bound the cron respawn uses for the identical launch), so a client disconnect never kills the launch.
- The handler answers as soon as the CLI's `--json` receipt line (`{"ok":true,"result":{"window","server","created"}}`) parses off stdout (30s bound): `rk operator` prints the receipt right after creating and role-stamping the window, before its best-effort kickoff delivery, so waiting for exit would make the button feel hung. The process finishes its kickoff after the response; a non-zero exit is logged, not surfaced.
- On a created receipt the SSE hub is woken for the server so the new window paints in one tick.
- Constitution I: argv slice, bounded contexts; `server` is validated by `serverFromRequest`, and the only client-supplied field is a `validate.ValidateWindowID`-checked window id. Constitution IX: a mutation ⇒ POST.

**Responses:**
- `202` `{ "windowId": "@7", "server": "default" }` — the receipt's `created: true`
- `400` `{ "error": "…" }` — malformed JSON body, or a `window` value that is not a well-formed window id
- `409` `{ "error": "operator already present", "code": "operator_exists", "windowId": "@7" }` — the pre-check found an operator, or the receipt reported `created: false` (a race the pre-check missed); the UI treats it as success
- `502` `{ "error": "<first non-empty stderr line>" }` — non-zero exit before a receipt (e.g. the CLI's `fab` precondition failure)
- `504` `{ "error": "operator start timed out" }` — no receipt within the 30s bound; the process is killed
- `500` session fetch failure

---

### Directories

Server-side directory autocomplete for the session creation dialog.

#### `GET /api/directories?prefix=:path`

**Query params:**

| Param | Type | Validation |
|-------|------|------------|
| `prefix` | `string` | Supports `~` expansion, must resolve under `$HOME` |

**Response** `200`:
```json
{
  "directories": ["~/code/sahil87/"]
}
```

**Behavior:**
- If prefix ends with `/`, lists child directories
- Otherwise, matches directory names against the basename prefix
- Skips hidden directories (`.`-prefixed)
- Returns paths with `~/` prefix when under home directory
- Returns empty array on invalid path

---

### File Upload

Upload files to a project's `.uploads/` directory.

#### `POST /api/sessions/:session/upload`

**Content-Type:** `multipart/form-data`

**Form fields:**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `file` | `file` | yes | Max 50 MB |
| `window` | `string` | no | Integer string, defaults to `"0"` |

**Response** `200`:
```json
{
  "ok": true,
  "path": "/Users/sahil/code/sahil87/run-kit/.uploads/260312-143022-screenshot.png"
}
```

**Behavior:**
- Resolves project root from the target window's `worktreePath`
- Creates `.uploads/` in project root if needed
- Auto-adds `.uploads/` to `.gitignore`
- Filename: `{YYMMDDHHmmss}-{sanitized_name}`
- Sanitization: strip null bytes, replace `/\` with `-`, strip leading dots, remove `..`, collapse dashes

---

### Server-Sent Events

Real-time session state stream.

#### `GET /api/sessions/stream`

**Event format:**
```
event: sessions
data: [{"name":"run-kit","windows":[...]}]
```

**Behavior:**
- Module-level hub singleton manages all connected clients
- Polls `FetchSessions()` every 2500ms (only when clients connected)
- Deduplicates by JSON comparison — only sends on change
- New clients receive the cached snapshot immediately
- 30-minute lifetime cap per connection
- Non-blocking fan-out (drops if client buffer full)

---

### Terminals Mux

A single WebSocket per browser tab carrying ALL pane relay streams (the retired
per-pane `WS /relay/{windowId}` was consolidated onto this mux in
`260717-803u-relay-mux`). A board with N panes holds ONE terminals socket, not N.

#### `WS /ws/terminals`

No URL params — every stream is opened in-band via an `open` control op. Stream
ids are client-allocated `u32`s, unique within a socket connection.

**Wire protocol:**

Binary data frames `[u32 BE streamId][payload]` in both directions (server→client
PTY output, client→server keystrokes). JSON text frames for control:

| Direction | Frame |
|-----------|-------|
| Client → Server | `{"op":"open","id":7,"server":"<tmux server>","windowId":"@42","cols":120,"rows":32,"isolate":true}` |
| Client → Server | `{"op":"resize","id":7,"cols":100,"rows":40}` |
| Client → Server | `{"op":"close","id":7}` |
| Server → Client | `{"op":"opened","id":7}` |
| Server → Client | `{"op":"closed","id":7,"code":4004\|4001\|1000,"reason":"..."}` |

`open`'s `isolate` field is optional (default `false`, absent decodes false).
When `true`, the stream attaches through the window's own single-window
`_rk-iso-<windowDigits>` session — created on demand with the window LINKED in
(it stays a member of its home session) — giving the stream an active-window
pointer independent of home's, so a borrowed or popped-out tile never fights the
home tab over the window. **Session pick order: pin → iso → home.** A pinned
window's `_rk-pin-*` session wins regardless of `isolate` (a pin already
isolates; no iso session is created for it); otherwise `isolate: true` ensures
and attaches the iso session; otherwise the home session is resolved as before.
The iso attach chains `destroy-unattached on` onto the attach invocation itself
(setting it at creation would destroy the never-attached session immediately),
so tmux reaps the iso session when its last client leaves — stream close, socket
teardown, or daemon crash — with no rk bookkeeping. An ensure failure is a
per-stream `closed` (4004 when the window is missing, 4001 otherwise); if the
PTY attach fails after a successful ensure, the relay kills the iso session only
when it has zero attached clients (another isolated viewer may share it).

**Per-stream lifecycle** (each `open` reproduces the former `handleRelay`
per-connection semantics, per stream):
1. Validate `windowId` (shared `validate.ValidateWindowID`) — a bad id yields a
   per-stream `closed` 4004, never a socket teardown.
2. Session pick per the pin → iso → home order above → session-scoped
   `SelectWindowInSession` (select+attach must agree on the session).
3. `forceTERM` (`TERM=xterm-256color`), best-effort `tmux.ReloadConfig`, then
   `pty.StartWithSize` at the open op's initial `cols`/`rows` (no
   wait-for-first-resize dance).
4. On success: reply `opened` (delivered before the stream's first data frame),
   then pump PTY output as binary data frames.
5. On stream close (client `close` op, PTY EOF, or socket teardown): cancel the
   attach context, close the PTY fd, kill the attach process (`sync.Once`), and
   reply `closed` (1000 graceful).

**Write path:** per-stream bounded send queues (8 × 4096B) drained by a single
writer goroutine scheduling control/short frames ahead of bulk output,
round-robin across ready streams (never FIFO across streams). A full per-stream
queue pauses that stream's PTY reader (backpressure), never dropping bytes.

**Per-stream `closed` codes** (the socket itself stays open for stream-level
failures):
- `4004` — window not found (resolve/select failed, or an isolated open's
  ensure found no window) or malformed window id
- `4001` — failed to attach to the tmux session (`pty.StartWithSize`) or an
  isolated open's ensure failed for another reason
- `1000` — graceful close (client `close` op or PTY EOF)

---

### Updates

Toolkit update surface. The daemon's periodic checker delegates the check to
one exec of `shll check-updates --json` (per-tool verdicts consumed
from its JSON; HexoKit's own row re-compared locally against the running
ldflags version).

#### `POST /api/updates/check`

On-demand update check: runs one immediate checker pass inline and returns the
fresh verdict synchronously (~1-2s, bounded by the checker's 30s exec timeout).

**Request body** (tolerant — absent body, empty body, and `{}` all mean the
released default, so existing clients are unchanged):
```json
{ "source": "github" }
```

- `source` — optional check-backend selector, a closed enum:
  - absent/empty → the **released** manifest backend (shll's default). This is
    the same code path as the 6h ambient loop: the pass updates the cached
    verdict and broadcasts the `update-available` event.
  - `"github"` → shll's GitHub release-tags backend
    (`shll check-updates --source github`) — fresh, but carrying **no notify
    policy** (every row arrives `notable=false`). A github check is a
    **side-channel query**: the verdict is computed and returned, but the
    cached verdict is NOT written and no `update-available` broadcast fires,
    so the chip, the dismissal key, and the scoped `shll update` argv stay
    bound to the released source.
  - any other non-empty value → `400 {"error": ...}` (fail-loud; the value
    never reaches the checker). Only the validated enum value maps to the
    literal `--source github` argv pair — nothing user-controlled is spliced
    into the command.
- A malformed JSON body degrades to the released default (mirroring
  `POST /api/update`'s tolerant posture).

**Response (200):** the same shape as the `update-available` event payload:
```json
{
  "tools": [
    { "tool": "hexokit", "current": "3.8.1", "latest": "3.9.0",
      "updateAvailable": true, "notable": true },
    { "tool": "tu", "current": "0.9.1", "latest": "0.9.2",
      "updateAvailable": true, "notable": false }
  ],
  "key": "hexokit@3.9.0",
  "current": "3.8.1",
  "latest": "3.9.0",
  "source": "released"
}
```

- `tools` — the full per-tool verdict list: every tool with a pending update,
  including sub-threshold rows (`updateAvailable` = installed < latest;
  `notable` = the bump crosses the tool's notify threshold). Up-to-date tools
  are omitted — an empty list means everything is current.
- `key` — composite dismissal key over the NOTABLE set (sorted `tool@latest`,
  comma-joined; empty when nothing notable).
- `current`/`latest` — legacy self-row compat fields (populated only when the
  HexoKit self row — `hexokit`, or legacy `rk`/`run-kit` — is in the notable set).
- `source` — echoes the report's self-identified backend (`"released"` /
  `"github"`), so the client reacts to what actually ran. The frontend
  suppresses the `(patch — below notify threshold)` toast annotation for
  github-sourced results (no notify policy exists in that backend).

**Errors:**
- `400 {"error": ...}` — unrecognized non-empty `source` value
- `409 {"error": ...}` — checker suppressed (dev build) or not wired
- `502 {"error": "update check unavailable — ..."}` — the check itself failed
  (shll not on PATH, non-zero exit — including an older shll without
  `--source` support — or unparseable JSON)

The ambient 6h loop is fail-silent (a failed pass retains the previous
verdict); only this manual endpoint surfaces check failures.

#### `event: update-available` (state socket / SSE global slot)

Broadcast whenever the checker's composite notable key changes (including to
empty when a match is consumed), and replayed to late-connecting clients from a
cached slot. The payload is byte-identical in shape to the
`POST /api/updates/check` response above (one shared builder serves both),
including the `source` field — the ambient slot carries `"released"` (github
checks are side-channel and never reach this slot).

---

### MCP

The daemon hosts the streamable-HTTP transport of the rk MCP server — the same
`internal/mcp` policy table and argv executor `rk mcp` (stdio) uses. Tools, the
allowlist, the `--json` envelope, and the timeout contract are owned by
[`mcp.md`](mcp.md); this section owns only the route.

#### `/mcp`

| Method | Role in the transport |
|--------|-----------------------|
| `POST` | Client → server JSON-RPC messages (tool calls, initialize, notifications) |
| `GET` | Server → client SSE stream for the session |
| `DELETE` | Session termination |

**Handler:** the official Go SDK's streamable-HTTP handler
(`github.com/modelcontextprotocol/go-sdk`), mounted on the root router. No protocol
code of our own.

**Stance:**
- **Tailnet-only, no auth of its own** — the same posture as every other daemon
  route; never exposed publicly. Its clients are MCP clients already on the tailnet
  (Claude Code and kin); the Claude Desktop app reaches HexoKit over stdio via
  `ssh <box> rk mcp`, not this route.
- **Origin validation** — when a request carries an `Origin` header, the handler
  rejects it unless the origin's scheme, host, and port match an allowlist derived
  from the daemon's own bind configuration (the configured `RK_HOST`:`RK_PORT`
  origin and the host's tailnet hostname and IP at that port), with an explicit
  loopback exception. The request `Host` header is never the reference — under DNS
  rebinding both headers carry the attacker's name (the MCP transport's
  DNS-rebinding guard, Constitution I).
- **CORS allowlist unchanged** — § Middleware's `GET POST OPTIONS` stays as is. MCP
  clients are not browsers; CORS governs only browser preflights.
- **Session state** — per-connection SDK state in memory for the connection's life
  only; nothing persisted (Constitution II).

**Constitution IX exception.** This is the only route on the daemon that uses a
verb other than `GET`/`POST`. The transport mandates all three methods on one path;
bending the transport would mean a non-conformant server no client could use. The
exception is recorded here, where the route table lives, so the constraint stays
visible; it grants nothing to any `/api/*` route.

---

### Tunnel

The daemon carries byte tunnels over a WebSocket so the desktop shell's native
web engine can route guest traffic through the rk host
([`window-views.md`](window-views.md) § Engines) behind ANY front end that
passes WebSocket upgrades. The endpoint lives under `/ws/*` beside the other
sockets: every front end rk works behind already passes WebSockets there (the
terminal relay and state socket depend on it), the Vite dev proxy upgrades
only `/ws`, and path-scoped WebSocket front-end configs (`location /ws/ { … }`)
already match.

#### `GET /ws/tunnel?target=<host>:<port>` (Upgrade: websocket)

An ordinary `GET` upgrade — no Principle IX exception. Handled by
`tunnel_ws.go` with its own dedicated upgrader. Every rejection happens BEFORE
the upgrade, as a plain HTTP error in the `{ "error": "..." }` shape, in this
order:

| Step | Check | Failure |
|------|-------|---------|
| 1 | Origin policy (§ WebSocket Origin policy below): the request carries NO `Origin` and NO `Sec-Fetch-Site` header | `403` |
| 2 | `target` parses via `net.SplitHostPort`, non-empty host, numeric port 1–65535 | `400` |
| 3 | Dial `target` with a `net.Dialer` timeout (10 s, a named constant) via `DialContext` on the request context; hostnames resolve on the rk host (Go's resolver — Docker service names, internal DNS, `*.localhost` all work) | `502` |
| 4 | Upgrade via the dedicated tunnel upgrader | gorilla's own handshake error |

**Dial before upgrade** — a completed handshake signals "connected", so the
desktop maps handshake open/failure directly onto Chromium's `200 Connection
Established` / `502 Bad Gateway` with no in-band signalling.

**Byte pipe** — modeled on the `gui_ws.go` WS↔TCP relay:
- Binary frames both ways. A TCP→WS pump goroutine is the ONLY WebSocket
  writer, reading 64 KiB chunks and writing each as one binary message;
  upstream EOF sends a normal close frame, then teardown.
- WS→TCP: binary messages are written verbatim to the TCP conn; text frames
  are ignored (forward-compat). A 1 MiB `SetReadLimit` bounds one inbound
  message (memory-DoS, the `guiReadLimit` rationale).
- Cleanup is close-driven and leak-free: either side ending closes BOTH the
  TCP conn and the WebSocket, and the handler waits for the pump goroutine —
  no goroutine or socket outlives the handler. NO idle cap and no fixed
  deadline on an established tunnel — HMR WebSockets and long-polls are
  long-lived. WebSocket has no half-close, so an upstream FIN ends the
  tunnel.

**Ping keepalive** — the server sends a WS ping control frame every 30 s (a
named constant) on an established tunnel, so front-end idle timeouts (nginx
`proxy_read_timeout` 60 s default, Cloudflare ~100 s) do not sever an idle HMR
socket inside the tunnel. `WriteControl` is safe concurrently with the pump
writer; the Node/undici client answers pings automatically.

**Destination policy: NONE.** The tunnel dials any destination — loopback,
LAN, internet — with no allowlist or blocklist. Rationale: anyone who can
reach rk already has a shell on the host through the terminal relay (rk has
no auth — Tailnet-only / SSH-tunnel-only by deployment), so restricting
destinations is security theater and adds no exposure beyond what rk already
grants. Browser pages cannot reach it at all (§ WebSocket Origin policy).

**Constitution stance** — no exception needed: a WebSocket upgrade is an
ordinary `GET`. The tunnel spawns no subprocess (net dialing only,
Constitution I) and holds no state beyond live connections (Constitution II).
`/proxy/{port}` and `/code` are untouched — they remain for the iframe
engine and browser viewers.

**Capability advertisement** — `GET /api/health` carries `tunnel` (a JSON
number, the daemon's listen port); older daemons omit the field (§ Health).
The desktop shell gates proxy mode on this field plus a live tunnel
round-trip to the host's own listen port.

#### WebSocket Origin policy

Browsers do not apply CORS to WebSockets, so each upgrader enforces its own
Origin policy. All rejections answer `403`.

**Tunnel upgrader** (`/ws/tunnel`) — the strictest acceptable policy: accept
ONLY requests carrying NO `Origin` header AND NO `Sec-Fetch-Site` header. The
tunnel's sole client is the Electron main process (a non-browser client);
every browser WebSocket carries an unsuppressable `Origin`, so this rejects
all browser pages — cross-site, same-site, and DNS-rebinding alike. rk's own
origin is rejected too (the SPA never opens the tunnel). The no-Origin rule
makes the tunnel immune to DNS rebinding.

**Shared upgrader** (`/ws/state`, `/ws/terminals`, `/ws/gui/{id}`) —
Fetch-Metadata-first same-origin policy:

| Step | Condition | Verdict |
|------|-----------|---------|
| 1 | `Sec-Fetch-Site: same-origin` | allow |
| 2 | `Sec-Fetch-Site` present with any other value (`cross-site`, `same-site`, …) | reject |
| 3 | `Sec-Fetch-Site` absent, `Origin` absent | allow (non-browser clients: Go/Node tooling, tests) |
| 4 | `Origin` host[:port] equals (case-insensitive, default ports 80/443 normalized) the first `X-Forwarded-Host` value when present, else the request's `Host` | allow |
| 5 | Anything else, including a malformed `Origin` | reject |

Scheme is not compared — a TLS front end terminates TLS, so `Origin:
https://…` meets a plain-http hop. The browser computes `Sec-Fetch-Site`
against the URL IT connected to, so a Host-rewriting front end (nginx
default, Tailscale Serve, load balancers) cannot break the SPA's own
sockets. Trusting `X-Forwarded-Host` is safe here: the browser `WebSocket`
API cannot set custom request headers, and a non-browser client can simply
omit `Origin`.

**Known limitations:**
- **DNS rebinding** is not stopped by the shared upgrader's Host-match rule
  (under rebinding both `Origin` and `Host` carry the attacker's name). The
  tunnel is immune via its no-Origin rule; the MCP transport's bind-derived
  allowlist is the precedent if the shared sockets ever need one.
- **CORS stays allow-all** (`AllowedOrigins: ["*"]`), so cross-site pages
  can still call `/api/*`. The WebSocket tightening is defense-in-depth for
  the socket surface, not a closure of the cross-site hole; CORS tightening
  is a follow-up.

---

### SPA Fallback

#### `GET /*` (catch-all, lowest priority)

- Requests matching files in `app/frontend/dist/` → serve file directly
- All other requests → serve `index.html` (client-side routing)
- Path traversal prevented
- Returns 404 if SPA not built

---

## Input Validation Summary

### Name Rules (sessions, windows)

| Rule | Detail |
|------|--------|
| Non-empty | After trimming whitespace |
| Max length | 128 characters |
| Forbidden chars | `` ; & | ` $ ( ) { } [ ] < > ! # * ? `` |
| Forbidden chars | `: .` (tmux target separator, path separator) |
| Forbidden chars | `\n \r \t` (control characters) |

### Path Rules (CWD, upload targets)

| Rule | Detail |
|------|--------|
| Non-empty | After trimming whitespace |
| Max length | 1024 characters |
| Forbidden chars | `\0 \n \r` |
| Security boundary | Must resolve under `$HOME` |
| Tilde expansion | `~` → `$HOME`, `~/path` → `$HOME/path`, `~user` → error |

### Filename Sanitization (uploads)

| Step | Transform |
|------|-----------|
| 1 | Strip null bytes |
| 2 | Replace `/` and `\` with `-` |
| 3 | Strip leading dots |
| 4 | Remove `..` sequences |
| 5 | Collapse consecutive dashes |
| 6 | Trim leading/trailing dashes and whitespace |
| 7 | Default to `"upload"` if empty |

---

## Changes from Current Implementation

| Current (multiplexed POST) | New (POST + path intent) | Rationale |
|---------------------------|------------------------|-----------|
| `POST /api/sessions { action: "createSession" }` | `POST /api/sessions` | POST to collection creates resource |
| `POST /api/sessions { action: "killSession" }` | `POST /api/sessions/:session/kill` | Intent in path, not action field |
| `POST /api/sessions { action: "createWindow" }` | `POST /api/sessions/:session/windows` | Sub-resource creation |
| `POST /api/sessions { action: "killWindow" }` | `POST /api/sessions/:session/windows/:index/kill` | Intent in path |
| `POST /api/sessions { action: "renameWindow" }` | `POST /api/sessions/:session/windows/:index/rename` | Intent in path |
| `POST /api/sessions { action: "sendKeys" }` | `POST /api/sessions/:session/windows/:index/keys` | Action as sub-resource |
| `POST /api/upload` (session in form field) | `POST /api/sessions/:session/upload` | Upload scoped to session in URL |

---

## Route Summary

| Method | Path | Handler file | Purpose |
|--------|------|-------------|---------|
| `GET` | `/api/health` | `health.go` | Health check |
| `GET` | `/api/sessions` | `sessions.go` | List all sessions + windows |
| `GET` | `/api/sessions/stream` | `sse.go` | SSE real-time stream |
| `POST` | `/api/sessions` | `sessions.go` | Create session |
| `POST` | `/api/sessions/:session/kill` | `sessions.go` | Kill session |
| `POST` | `/api/sessions/:session/windows` | `windows.go` | Create window |
| `POST` | `/api/sessions/:session/windows/:index/kill` | `windows.go` | Kill window |
| `POST` | `/api/sessions/:session/windows/:index/rename` | `windows.go` | Rename window |
| `POST` | `/api/sessions/:session/windows/:index/keys` | `windows.go` | Send keystrokes |
| `POST` | `/api/sessions/:session/upload` | `upload.go` | File upload |
| `GET` | `/api/directories` | `directories.go` | Directory autocomplete |
| `POST` | `/api/update` | `update.go` | One-click toolkit upgrade (scoped/force) |
| `POST` | `/api/updates/check` | `update.go` | On-demand update check (inline checker pass, synchronous verdict) |
| `WS` | `/ws/terminals` | `terminals_ws.go` | Terminals mux (all pane relays, one socket/tab) |
| `WS` | `/ws/tunnel` | `tunnel_ws.go` | Byte tunnel to `host:port` for the desktop web tile (§ Tunnel) |
| `POST` | `/api/windows/:windowId/send` | `send.go` | Compose-strip send into a window's pane (the injection engine's HTTP door) |
| `POST` | `/api/layout/borrow` | `layout_borrow.go` | Move a surface leaf into a tab (`{to, leaf, tree}`); the current holder's tree-minus-leaf and the target's tree write in one chained tmux invocation |
| `POST` | `/api/layout/return` | `layout_borrow.go` | Send a held surface leaf home (`{from, leaf}`); the server recomputes both trees from live tmux state and re-adds a dismissed home slot |
| `POST` | `/api/windows/:windowId/operator-request` | `operator.go` | Window-scoped operator request (closed template registry; busy ⇒ 202 queued) |
| `POST` | `/api/operator-request` | `operator.go` | Server-scoped operator request (same registry) |
| `POST` | `/api/operator/start` | `operator_start.go` | Start the server operator (execs `rk operator -L <server> --json`; answers on the receipt line) |
| `POST` | `/api/notify` | `push.go` | Web Push notification to subscribed devices |
| `POST` | `/api/riff` | `riff.go` | Spawn worktree + window + agent (riff engine) |
| `GET` | `/api/boards` | `boards.go` | List boards |
| `GET` | `/api/boards/:name` | `boards.go` | Board entries (server, windowId, session, windowIndex, windowName, orderKey, panes) |
| `POST` | `/api/boards/:name/pin` | `boards.go` | Pin a window to a board (`{server, windowId}`) |
| `POST` | `/api/boards/:name/unpin` | `boards.go` | Unpin a window from a board |
| `POST` | `/api/boards/:name/reorder` | `boards.go` | Reorder a pinned window (`{server, windowId, before?, after?}`) |
| `POST` `GET` `DELETE` | `/mcp` | `mcp.go` | MCP streamable-HTTP transport (Constitution IX exception, see § MCP) |
| `GET` | `/*` | `spa.go` | SPA static + fallback |
