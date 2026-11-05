# OpenAI MCP: The Daemon's Tools in ChatGPT

> One switch in Settings puts the daemon's MCP tools in front of ChatGPT (and any
> other OpenAI product bound to the same tunnel) through OpenAI's Secure MCP Tunnel.
> The daemon installs, configures, and runs OpenAI's `tunnel-client` the way it
> runs code-server and the GUI supervisor: a sibling tmux session, re-ensured on
> every daemon start, never a child of the daemon process. No inbound port opens;
> `tunnel-client` makes only outbound HTTPS calls to OpenAI.
>
> **Status**: implemented (settings, managed install, lifecycle, routes, status
> stream, Settings section, palette, CLI, doctor).
>
> Companions: [`mcp.md`](mcp.md) (the server and its tool table; § Transports
> carries the exposure exception this page introduces), [`api.md`](api.md) § MCP
> (the `/mcp` route), [`gui.md`](gui.md) (the on/off switch pattern this page
> copies), [`right-panel.md`](right-panel.md) (code-server, the managed-download
> pattern this page copies). External: OpenAI's guide
> <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels> and
> <https://github.com/openai/tunnel-client>.

---

## Name

Settings prefix `openai_mcp`, label "ChatGPT connector", CLI `rk openai-mcp`,
tmux session `rk-openai-mcp`, state directory `<state>/openai-mcp/`, SSE event
`openai-mcp`, doctor row `openai-mcp`.

Not "tunnel": the word already names `/ws/tunnel` (`api/tunnel_ws.go`) and the
`rk remote` SSH-tunnel port block (`PORTPOLICY_TUNNEL_*`). Not "chatgpt" alone:
the same tunnel serves Codex and the Responses API, and OpenAI owns both ends of
the relay.

---

## What the user does

1. Creates a tunnel at <https://platform.openai.com/settings/organization/tunnels>,
   associates it with their ChatGPT workspace, and mints a runtime API key whose
   principal has **Tunnels Read + Use**. Both steps are OpenAI's; HexoKit links to
   the page and does nothing else here (§ Out of scope).
2. Opens Settings → General → **ChatGPT connector**, pastes the tunnel ID and the
   API key, and turns the switch on.
3. The daemon downloads `tunnel-client` if it is not installed, starts it, and the
   row's status line moves `installing` → `starting` → `ready`.
4. In ChatGPT: Settings → Connectors → add a custom MCP server, Connection
   **Tunnel**, pick the tunnel, auth **none**.

Turning the switch off stops `tunnel-client`. The tunnel itself, the key file, and
the tunnel ID stay, so turning it back on needs no re-entry.

---

## Settings

Two registry entries (`internal/settings`), both rendered by the generic
**All settings** panel and by the curated row below:

| Key | Kind | Default | Validation | On change |
|-----|------|---------|------------|-----------|
| `openai_mcp.enabled` | bool | `false` | bool | on → ensure; off → kill |
| `openai_mcp.tunnel_id` | string | `""` | empty, or `tunnel_` followed by one or more `[A-Za-z0-9]` | when enabled: kill, then ensure |

The API key is **not** a registry entry. `config.yaml` is often dotfiles-managed
(Constitution II, the VAPID precedent), so the key lives in the state home:

- **File**: `<state>/openai-mcp/api-key`, mode `0600`, directory `0700`, written
  with `internal/fsatomic` (temp + rename). The file holds the key and a trailing
  newline, nothing else.
- **Route**: `POST /api/openai-mcp/key`, body `{"key":"<value>"}`. A non-empty
  value must match `^sk-[A-Za-z0-9_-]{20,}$` or the route answers `400` before
  touching disk. `{"key":""}` deletes the file. Success answers
  `200 {"ok":true,"keySet":<bool>}` and, when the switch is on, restarts
  `tunnel-client` (kill, then ensure) so the new key takes effect. POST per
  Constitution IX.
- **Never read back.** No route returns the key. `keySet` (file exists and is
  non-empty) is the only fact the browser ever learns, through the route's
  response and the SSE status event.
- **Restart route**: `POST /api/openai-mcp/restart` kills and re-ensures
  `tunnel-client` (the palette's Restart). `409` while the switch is off; a
  failed ensure answers `500` with the cause.
- **Transport stance**: the POST crosses the daemon API like every other setting:
  tailnet-only, no auth of its own (`api.md` § Stance). The key is exactly as
  protected as the daemon's other mutating routes.

---

## The curated row

Settings → General gains a **ChatGPT connector** section under the existing MCP
endpoint row, because the connector is that endpoint's off-box door:

- The `openai_mcp.enabled` switch.
- A Tunnel ID text field bound to `openai_mcp.tunnel_id`.
- An API key field: write-only, never prefilled. It shows "Saved" when `keySet` is
  true, with **Replace** and **Clear** actions.
- One status line from the SSE event (§ Status), with a link to the Platform
  tunnels page while the state is `unconfigured`.

No new settings page or tab (Constitution IV).

---

## Lifecycle

The `gui.enabled` pattern (`internal/daemon/gui.go`), with code-server's
install path (`internal/daemon/codeserver.go`).

### Ensure

`ensureOpenAIMCPCore(opts)` runs in one of three postures:

| Posture | Caller | On failure | Missing binary | Running session, profile changed |
|---------|--------|-----------|----------------|-----------------------------------|
| daemon start | `startSession`, after `ensureGUI` | log, carry on | install job | restart |
| from daemon | settings and key POSTs, Restart | error | install job | restart |
| from CLI | `rk openai-mcp start` (also the install job's own start) | error | error | leave it alone |

A manual CLI call may run in a shell whose `RK_PORT`/`RK_HOST` differ from the
daemon's, so only callers in the daemon's own environment may move a working
tunnel onto a re-derived profile. In order:

1. `openai_mcp.enabled` false → nothing.
2. Tunnel ID empty, or the key file missing or empty → nothing (status
   `unconfigured`).
3. The `rk-openai-mcp` session exists → nothing, unless the posture restarts on
   a profile change and the derived profile differs from the file on disk: then
   kill and continue.
4. Resolve the binary: the managed install's `current` symlink first, then
   `tunnel-client` on `PATH`. Neither found → spawn an rk-jobs window running
   `rk openai-mcp install && rk openai-mcp start` (the code-server precedent)
   and return (status `installing`), or error in the CLI posture.
5. Write the derived profile (§ Profile) and spawn the session.

### Reconcile

The session outlives daemon restarts by design, so settings changed by any
writer other than the settings POST (a hand edit, a dotfiles sync, a change
made while the daemon was down) could leave a tunnel-client running while every
surface says off. `ReconcileOpenAIMCP` kills a session the settings no longer
allow (off, or the tunnel ID or key gone). It runs at daemon start before the
ensure, and from `WatchOpenAIMCPSettings`, which `rk serve` runs for its whole
life: every 5 s it stats the settings file and reconciles when it changed. The
watch is the daemon's, not the status hub's, because the hub only polls while a
browser is connected, and the tunnel must stop whether or not anyone is
looking. It touches no tmux while the settings allow the connector or the
daemon is down.

### Spawn

A sibling session on the rk-daemon tmux socket, created through `runTmux`
(`exec.CommandContext` with a timeout, Constitution I):

```
tmux new-session -d -s rk-openai-mcp \
  env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY \
  <bin> run --profile-dir <state>/openai-mcp/profile --profile openai-mcp
```

The key never appears in argv or the environment; the profile references the
key file (§ Profile). Both variables are stripped because `tunnel-client`
prefers either one over the profile's `api_key`: `CONTROL_PLANE_API_KEY` first,
then `OPENAI_API_KEY`. A daemon started from a shell that exports
`OPENAI_API_KEY` would otherwise tunnel with that key instead of the one saved in
Settings.

### Kill and restart

`KillOpenAIMCPSession` kills the session by exact-match target. Restart checks
the daemon first (a down daemon touches no tmux), then kills, then ensures in
the from-daemon posture, so a missing binary starts the install job. There is no supervisor loop: `tunnel-client` retries control-plane
errors on its own, and a process that exits shows as `stopped` until the user
restarts it (palette, CLI) or the daemon restarts.

### Daemon restart

A daemon restart kills only the `rk-daemon` session (`daemon.go`), so
`rk-openai-mcp` keeps running across the restart. Requests that land while
`/mcp` is down should fail with a transport error and succeed again once the
daemon is back. That is unverified; the external-integration pass checks it
(§ Testing), and if `tunnel-client` stops polling instead, the daemon restarts
the session after its listener comes back. `rk daemon restart --full` kills the tmux server,
and the next daemon start re-ensures.

---

## Profile

`<state>/openai-mcp/profile/openai-mcp.yaml`, regenerated on every ensure from
settings. It is derived, not stored: deleting it changes nothing but the next
ensure's write. Written with `internal/fsatomic`, mode `0600`.

```yaml
config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "<openai_mcp.tunnel_id>"
  api_key: "file:<state>/openai-mcp/api-key"
health:
  listen_addr: "127.0.0.1:0"
  url_file: "<state>/openai-mcp/health.url"
admin_ui:
  open_browser: false
log:
  level: info
  format: json
mcp:
  startup_wait_timeout: "60s"
  server_urls:
    - channel: main
      url: "http://<mcp host>:<daemon port>/mcp"
```

- **MCP host**: the daemon's bind host (`RK_HOST`, default `127.0.0.1`). An
  unspecified bind (`0.0.0.0`, `::`) maps to `127.0.0.1`.
- **Daemon port**: the resolved daemon port (`RK_PORT` > `config.yaml` `port` >
  `PORTPOLICY_DAEMON_DEFAULT`).
- **Health listener**: an ephemeral port, discovered through `url_file`. No new
  port-policy entry.
- **Startup wait**: `tunnel-client` builds a startup catalog from `/mcp` before
  its first control-plane poll, and if `/mcp` is unreachable at that moment it
  logs `startup catalog failed; control-plane polling disabled` and never polls.
  `startup_wait_timeout` makes it wait for the listener. Daemon start runs the
  ensure right after spawning `rk serve`, before `/mcp` is up; the 60-second wait
  covers the daemon's own startup.

`tunnel-client` reaches `/mcp` with no `Origin` header, so `originGuard` passes it
(`mcp.md` § Transports). It depends on two `/mcp` properties shipped with this
feature: `/.well-known/*` answers `404`, so OAuth discovery concludes "no auth"
instead of retrying forever, and the handler is stateless, so MCP `2026-07-28`
requests from ChatGPT are accepted.

---

## Managed install

`internal/openaimcp` (an install library with no tmux code, the
`internal/codeserver` shape):

- **Source**: GitHub `openai/tunnel-client`, latest release (`/releases/latest`),
  asset `tunnel-client-v<ver>-<os>-<arch>.zip` for `linux|darwin` ×
  `amd64|arm64`. This is the same build Homebrew ships. The `tunnel-client-runtime-*`
  build is not used (§ Decisions).
- **Integrity**: the asset's GitHub `digest` (`sha256:<hex>`) must be present and
  the download must match it. A missing digest or a mismatch aborts (fail closed,
  the code-server rule). The digest equals the release's own `SHA256SUMS.txt`
  entry (checked for v0.0.19).
- **Layout**: extract only the `tunnel-client` member to
  `<state>/openai-mcp/bin/<ver>/tunnel-client` (mode `0755`), then swap the
  `<state>/openai-mcp/bin/current` symlink atomically. Old versions are pruned.
- **Other platforms** (Windows): `install` reports unsupported; the `PATH`
  fallback still applies.

---

## Status

The SSE stream gains `event: openai-mcp`, replayed to late joiners (the
`code-server` event's shape), computed by the daemon and cached for 5 s:

```json
{"enabled":true,"tunnelIdSet":true,"keySet":true,"state":"ready","detail":""}
```

| `state` | When |
|---------|------|
| `off` | switch off |
| `unconfigured` | switch on, tunnel ID or key missing |
| `installing` | the install job window exists |
| `stopped` | configured, but no daemon session (a foreground `rk serve`): no tmux is read; `detail` says so |
| `stopped` | configured, no `rk-openai-mcp` session |
| `starting` | session exists, health URL missing or unreachable |
| `ready` | `GET <health>/readyz` answers `200` |
| `degraded` | `/readyz` answers non-`200`; `detail` carries its body (first line, capped at 200 bytes) |

The daemon probes; the browser never polls (code-quality anti-pattern).

---

## Palette

Pure builder `app/frontend/src/lib/palette/openai-mcp.ts`, the `gui.ts` shape:

- `openai-mcp-turn-on`: "ChatGPT connector: Turn on", posts
  `{"openai_mcp.enabled":true}`; listed while off.
- `openai-mcp-turn-off`: "ChatGPT connector: Turn off"; listed while on. No
  confirm dialog: nothing is lost by stopping.
- `openai-mcp-restart`: "ChatGPT connector: Restart"; listed while on and
  configured.

---

## CLI

`rk openai-mcp install | start | restart`, the `rk code-server` verbs:

- `install`: managed download (§ Managed install); prints the installed version.
- `start`: ensure with errors surfaced (`cli=true`).
- `restart`: kill, then ensure.

On/off stays in Settings and the palette. Checked against `shll standards`
before the verbs ship (Constitution § Toolkit Standards).

---

## Doctor

A row named `openai-mcp`, always OK-shaped like the `gui` and `code-server`
rows: off is the default and a connector that is not ready is a state, never a
dependency failure. The note carries the state:

- `off`
- `on: unconfigured, <what is missing> (Settings → ChatGPT connector)`
- `on: installing tunnel-client (rk-jobs window openai-mcp-install)`
- `on: not running (rk openai-mcp start)`, or the missing-binary detail
- `on: starting`, `on: ready (rk-openai-mcp session)`, `on: degraded, <readyz body>`
- `on: daemon not running (rk serve -d)`: the probe's tmux reads are gated on the
  daemon, so a down daemon is reported without touching tmux.

---

## Security

- **What becomes reachable**: every tool in the policy table, destructive rows
  included (`send`, `kill`, `code_exec`, `cron_add`, `riff`, …). The switch is
  the user's acceptance of that. HexoKit adds no per-tool filter (§ Out of scope).
- **Who can reach it**: OpenAI gates it. A ChatGPT user needs the tunnel
  associated with their workspace, the Tunnels Use permission, and the connector;
  the operator needs Tunnels Read + Use on the runtime key. A prompt-injected
  ChatGPT conversation can call any tool the connector exposes.
- **No inbound exposure**: `tunnel-client` dials out to `api.openai.com:443`;
  nothing listens on a public interface. Its health and admin UI bind loopback.
- **Key handling**: `0600` file in the state home, referenced by `file:` path,
  never in argv, env, `config.yaml`, logs, or any response body. The spawn strips
  the environment variables `tunnel-client` would prefer over it (§ Spawn).
- **One poller per tunnel**: two `tunnel-client`s polling the same tunnel split
  ChatGPT's requests between them, and neither one's readiness shows it. The
  curated row's help text says so; HexoKit cannot detect another host's poller.

### `mcp.md` amendment

§ Transports, "Tailnet-only, no auth of its own", becomes:

> `/mcp` is never served on a public listener. One opt-in exception relays it
> outward: with `openai_mcp.enabled`, the daemon runs OpenAI's `tunnel-client`,
> which dials out to OpenAI and forwards ChatGPT's requests to `/mcp` over
> loopback ([`openai-mcp.md`](openai-mcp.md)). OpenAI's workspace association and
> Tunnels permissions gate who can call it; HexoKit adds no auth of its own.

The out-of-scope entries that defer public exposure narrow to "an auth layer on
`/mcp`, or serving it on a public listener".

---

## Constitution mapping

- **I Security First**: every exec through `exec.CommandContext` with a timeout;
  tmux through `internal/tmux` / `runTmux`; the key never in argv; the binary
  checksum-verified, fail closed.
- **II Disposable Daemon**: durable inputs only (settings in `config.yaml`, the key
  file, the tmux session); the profile is derived and regenerated; status is
  recomputed, never stored.
- **IV Minimal Surface Area**: a section inside the one settings surface; two new
  routes (key, restart) with this page as their justification.
- **V Keyboard-First**: on, off, and restart in the palette.
- **VI Tmux Sessions Survive Server Restarts**: `tunnel-client` lives in a sibling
  session; daemon restarts never touch it.
- **VII Convention Over Configuration**: off by default; host, port, paths, and
  health port derived.
- **IX Uniform HTTP Verb**: both routes are POST.

---

## Testing

- **Unit (Go)**: registry entries and `tunnel_id` validation; profile derivation
  (host mapping, port resolution, `file:` key reference); key-route validation,
  `0600` mode, clear-deletes; install against an `httptest` release server
  (happy path, checksum mismatch, missing entry, zip without the member);
  ensure/kill argv through package-var seams (`withCodeServerSeams` shape),
  including the `env -u CONTROL_PLANE_API_KEY -u OPENAI_API_KEY` prefix; status
  classification over each `state`; doctor row branches.
- **Unit (frontend)**: the palette builder; the curated row's states (key saved,
  unconfigured link, status line).
- **Integration**: settings POST → ensure/kill hooks (injected on `Server`, the
  `guiEnsureFn` precedent); key POST → restart hook; real `tunnel-client doctor`
  against a rig daemon's `/mcp` (`oauth_metadata` passes).
- **E2E**: Playwright on the throwaway rig: toggle on/off, key save/clear, status
  line; `just demo openai-mcp` before/after, desktop and mobile.
- **External integration** (Constitution § PR Evidence): a ChatGPT tool call
  through a real tunnel to a rig daemon, recorded. It needs a real tunnel ID and
  key, and no other poller on that tunnel during the run. The same pass restarts
  the rig daemon mid-session and records whether ChatGPT's next call succeeds
  (§ Daemon restart).

---

## Out of scope

- Creating, listing, or deleting tunnels (needs an OpenAI admin key; the Platform
  UI does it).
- A per-tool allowlist for the connector. The table is compiled in, and
  `mcp.md` § Out of scope defers configurability.
- OAuth on `/mcp`.
- Cloudflare-mode tunnels and multiple tunnels per host.

---

## Decisions

### HTTP `/mcp` as the target, not `rk mcp` over stdio
**Decision**: `tunnel-client` forwards to the daemon's `/mcp`.
**Why**: one MCP endpoint per host, already live, already Origin-guarded; status
and doctor already know it. Verified end to end through ChatGPT once `/mcp`
404s `/.well-known/*` and runs stateless.
**Rejected**: stdio (`tunnel-client` spawning `rk mcp`): works today and needs no
`/mcp` changes, but runs a second MCP server process per host that the daemon
does not see.

### Key in the state home, written through a dedicated route
**Decision**: `POST /api/openai-mcp/key` writes `<state>/openai-mcp/api-key`
(`0600`); the profile references it as `file:`.
**Why**: paste-and-go from the UI; `config.yaml` may be in a dotfiles repo;
`file:` keeps the key out of argv and env.
**Rejected**: an `env:` or `file:` reference typed into settings (the daemon's
environment rarely carries the key; a secrets manager usually injects it into
interactive shells only); a write-only registry kind (teaches the registry about
secrets for one key).

### Managed download of the plain build
**Decision**: `tunnel-client-v<ver>-<os>-<arch>.zip`, verified against the
asset's GitHub digest, with a `PATH` fallback.
**Why**: the code-server precedent; the plain build is the one Homebrew ships and
the one this feature was verified with.
**Rejected**: `PATH` only (setup is no longer one switch); the
`tunnel-client-runtime-*` build (smaller, but its CLI surface was not verified).

### No supervisor loop
**Decision**: ensure on daemon start and on changes; restart by hand.
**Why**: parity with code-server and the GUI supervisor; `tunnel-client` already
retries control-plane failures.
**Rejected**: re-ensure from the SSE tick (a supervisor loop by another name).
