# Intake: Daemon Port Config Key

**Change**: 260925-v1r0-port-config-key
**Created**: 2026-09-25

## Origin

One-shot `/fab-new` invocation, row **P3** of `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` (decision D17):

> Daemon port gets a config.yaml key (P3 of fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md, D17). Today the port is env-only (RK_PORT; no registry key, no serve flag), so there is nowhere durable to pin an existing install and no documented way to move. Add `port` to the internal/settings registry, default 3000 (unchanged here), precedence code default < config.yaml < RK_PORT < CLI flag; RK_CODE_SERVER_PORT still falls back to port+2. Amend constitution IV (v1.11.0 -> 1.12.0): port becomes a config.yaml key that also keeps its env form; RK_PORT/RK_HOST/RK_CODE_SERVER_PORT remain the only env forms. Also make `rk daemon start`/`restart` resolve the port from config + env at call time and pass it into the rk-daemon session explicitly (-e, as the log path already is) — the daemon's tmux server otherwise keeps the environment it was born with, so a changed port may not take effect on restart (unverified; the change must test it). Non-disruptive: nobody's port changes. Read the whole plan file first for the rules table (D2 etc — rk/RK_*/@rk_*/rk-* are never renamed) and this row's full text.

Two scope questions were asked at intake and answered by the user:

1. **No `rk serve --port` flag** in this change. The precedence chain for port is code default < config.yaml < `RK_PORT`. The "< CLI flag" rung stays generic constitution wording; no port flag exists or is added.
2. **`port` is file/API-only** — registry `ui: false` (like `riff_presets`), so it does not appear in the Settings dialog.

The plan's rules table binds this change (D2: `rk`, every `RK_*` env var, `@rk_*` option, `rk-*` session/socket name is never renamed — `RK_PORT` stays exactly `RK_PORT`). Rule P: this change is the enabler for C4's port pin (C4 writes the effective port into this key during the `~/.config/hexokit` migration) and for C5's later default flip to 6123. **This change moves nobody's port.**

## Why

1. **Problem**: the daemon port is env-only. `internal/config.Load()` reads `RK_PORT` (default 3000) and nothing else. There is no durable per-install place to record "this machine serves on port N": env lives in `.env`/`.env.local` (repo-scoped, dev only), direnv, or whatever shell ran `rk daemon start`. A brew-installed user has no documented way to change the port at all.
2. **Consequence if not done**: the rebrand's port plan (rule P) cannot be non-disruptive. C5 flips the default 3000 → 6123; without a config key, C4 has nowhere to pin existing installs to 3000, so every existing user's Tailscale Serve mapping, bookmarks, phone shortcuts and MCP clients at `…:3000/mcp` would break at once.
3. **Second latent problem — the born-with environment**: `rk daemon start` spawns `rk serve` inside the `rk-daemon` session on the `rk-daemon` tmux socket (`internal/daemon/daemon.go` `startSession`). That tmux server is multi-tenant and long-lived: sibling sessions `rk-code-server`, `rk-jobs`, `rk-remotes` and the `_rk-ctl` anchor keep it alive across ordinary `daemon restart`s, which only reap the `rk-daemon` session. A tmux `new-session` against a live server builds the new session's environment from the **server's global environment** (fixed when the server was born, from the environment of the first client to touch the socket — `runTmuxInDir` passes no env override) plus only the variables in `update-environment` (DISPLAY, SSH_AUTH_SOCK, …; not `RK_PORT`). So:
   - A changed `RK_PORT` in the caller's shell probably never reaches the respawned `rk serve` while the server lives.
   - Once `port` exists in config.yaml, this gets worse: a server born with `RK_PORT=3000` in its environment (e.g. the first `rk daemon start` ran inside the direnv'd run-kit repo) holds that stale env value forever. Env beats config.yaml, so a later `port: 6123` edit + `rk daemon restart` would silently keep serving on 3000.
   This mechanism is **unverified** (the user flagged it) — the change MUST prove it with a test before and after the fix.
4. **Why this approach**: a registry key is how every other per-instance preference works (Constitution IV, `internal/settings` is the single source of truth), and `RK_PORT` keeps working unchanged, so the change adds a lower-precedence home without disturbing any existing deployment. Passing the resolved port into the session explicitly (`-e RK_PORT=<resolved>`, the same way `RK_DAEMON_LOG` is already passed) makes the respawned serve see exactly what the caller resolved, whatever the server was born with. `-e` was preferred over a `serve --port` argv flag because the serve process calls `config.Load()` from many places (router, SSE, health, proxy, code-server resolution). An env value reaches every one of them; a flag would need its own process-wide plumbing.

## What Changes

### 1. `internal/settings` — new `port` registry key

Add a `Port` field and one registry entry to `app/backend/internal/settings/settings.go`.

```go
// Port is the daemon listen port pinned in config.yaml. 0 means "unset":
// the effective port falls back to the code default (config.DefaultPort).
// RK_PORT, when set to a valid port, wins over this key. Read at serve
// startup (and by every CLI that resolves the origin), so a change applies
// on the next daemon restart.
Port int
```

Registry entry (placed among the scalar keys — suggested right before `tmux_conf` in the `advanced` group, or a `connectivity` category next to `ssh_host`; the apply stage picks one and states it):

| Field | Value |
|-------|-------|
| `key` | `port` |
| `kind` | `port` (new kind — the frontend panel renders unknown kinds read-only, and `ui: false` keeps it off the dialog anyway) |
| `def` | `"3000"` (text form of the code default; must come from the same constant `internal/config` uses, never a second literal) |
| `desc` | e.g. `Daemon listen port. RK_PORT wins when set. Takes effect on the next daemon restart (rk daemon restart); re-point Tailscale Serve / bookmarks after a move.` |
| `category` | `connectivity` (or `advanced`) |
| `ui` | `false` (user decision — file/API only) |
| `live` | `false` (applies on the next daemon restart) |

Hook semantics:

- **parse** (tolerant read): quote-strip + trim, `strconv.Atoi`, keep only when 1–65535; anything else leaves `Port = 0` (unset). Never errors.
- **serialize**: emit `port: <n>\n` whenever `Port != 0`, **including a value equal to the default**. This differs deliberately from the omit-at-default convention of the other scalars. The key is a pin: C4 will write `port: 3000` into existing installs, and that pin has to survive (a) any later settings save, since `Save` rewrites the whole file from `serialize`, and (b) C5's default flip to 6123. With omit-at-default, a settings POST between C4 and C5 would silently drop the pin. `Port == 0` emits nothing, so an untouched file still round-trips byte-identically.
- **read** (GET `/api/settings`): the explicit value as a JSON number, or `null` when unset (`Port == 0`). The registry `default` field (`"3000"`) tells the client what unset means.
- **apply** (POST `/api/settings`, Constitution IX partial merge): `null` → unset (`Port = 0`). A JSON number, or a numeric string (tolerated for hand-crafted clients — the apply stage may decide numbers-only and record it), in 1–65535 → set. Anything else → validation error, no mutation.

Update the package doc comment: env forms still exist only for `RK_PORT`, `RK_HOST`, `RK_CODE_SERVER_PORT`; `port` is now a config.yaml key that also has an env form (`RK_PORT`). `RK_HOST` and `RK_CODE_SERVER_PORT` gain **no** config key.

Registry-count consumers: memory says "18-key inventory". Tests asserting the registry length or key order (`registry_test.go`, `settings_test.go`, `api/settings_test.go`, and any frontend test snapshotting `/api/settings` rows) need the new row.

### 2. `internal/config` — port resolution reads config.yaml

`app/backend/internal/config/config.go` `Load()` becomes:

```text
cfg.Port = DefaultPort (3000)                        // code default
if s := settings.Load(); validPort(s.Port) { cfg.Port = s.Port }   // config.yaml
if RK_PORT set and valid { cfg.Port = RK_PORT }      // env wins
```

- Export the default as a named constant (e.g. `config.DefaultPort = 3000`) and have the settings registry `def` derive from it. `internal/config` → `internal/settings` is cycle-free: settings depends only on `internal/gui` and `internal/validate`, neither of which imports config. (Verified with `go list -deps`.)
- An invalid `RK_PORT` (non-numeric or out of range) keeps today's behavior: it is ignored and the lower rung applies. With this change the lower rung is the config.yaml value when present, otherwise 3000.
- `RK_HOST` and `RK_CODE_SERVER_PORT` resolution is unchanged. `ResolvedCodeServerPort()` is unchanged in code: it already falls back to `c.Port + 2`, so a config.yaml `port: 4000` yields code-server on 4002 with no extra work. Add a test asserting it.
- Consider exposing the source of the resolved port (e.g. `Config.PortSource` = `default|config|env`) **only if** a consumer in this change needs it (e.g. the `guardPortAvailable` message below). Otherwise skip it (no speculative surface).
- Every existing `config.Load()` caller picks the new rung up automatically: `serve`, `daemon status`/`stop`/`start`, `restart --force`, `guardPortAvailable`, `ensureCodeServer`, `doctor`, `origin.go` (`rk url`, `rk notify`, `tab_wake`), `api/router.go`, `api/health.go`, `api/proxy.go`, `sessions`, `riff`, `operator`, `fork`, `closed`, `tutorial`, `cron_respawn_session`. The plan should grep `config.Load()` and confirm none of them has a reason to see the env-only value.
- Caveat for `origin.go` `resolveOrigin`: its rung 1 is "explicit env wins: `RK_HOST` or `RK_PORT` set in the caller's environment". A config.yaml `port` is **not** explicit env, so it must not jump that rung. It flows into rung 3 (the `config.Load()` default derivation), below the covering tmux server's `@rk_srv_origin`. Verify the existing ordering holds and add a test if one is missing.

### 3. `internal/daemon` — pass the resolved port into the rk-daemon session

`startSession` (`app/backend/internal/daemon/daemon.go`), the single funnel for `Start()`, `StartWithBinary()` (`rk update`'s restart path), `Restart()`, and the desktop "Start & connect" path:

```go
args := []string{"new-session"}
if logPath, ok := resolveDaemonLogPath(); ok {
    args = append(args, "-e", LogEnvVar+"="+logPath)
}
args = append(args, "-e", "RK_PORT="+strconv.Itoa(config.Load().Port))   // NEW — resolved at call time
args = append(args, "-d", "-s", SessionName, "-n", WindowName, exe, "serve")
```

- The value is `config.Load().Port`, resolved in the **calling** process at call time: config.yaml plus the caller's `RK_PORT`. It is always passed, whether or not the caller had `RK_PORT` set, so the stale born-with value can never win.
- Name the env key through a constant (reuse or add one, e.g. `PortEnvVar = "RK_PORT"` in `internal/config`; the tmux sanitizer already strips `RK_*` from user-facing servers, and that is unaffected). No magic string.
- **`RK_HOST` and `RK_CODE_SERVER_PORT` have the same born-with staleness.** Recommended: pass all three resolved values (`-e RK_HOST=<cfg.Host>`, and `-e RK_CODE_SERVER_PORT=<n>` only when an override is set, since passing a `+2` value would turn the convention into an override). The row names only the port, so the plan decides and records it. Minimum scope is `RK_PORT`.
- `guardPortAvailable` already calls `config.Load()`, so it now checks the same port the session will bind. Update its error text to name both homes while **keeping the `RK_PORT` substring** (scripts pattern-match it). Example: `Stop it first, or set a different port (port: in ~/.config/run-kit/config.yaml, or RK_PORT).`
- `serve` help text (`app/backend/cmd/rk/serve.go` Long): document the config key and precedence, e.g.
  ```
  Port resolution (lowest to highest): default 3000 < `port:` in
  ~/.config/run-kit/config.yaml < RK_PORT.
  ```
  Keep the examples. Check `shll standards` for help-output rules before editing (Constitution § Toolkit Standards).
- `rk daemon start`/`restart` `Long` help: one line saying the daemon resolves the port from config.yaml + env at start time, so changing either and running `rk daemon restart` moves it.

### 4. Verify the born-with-env hypothesis, and lock the fix in with tests

The user flagged the mechanism as **unverified**, so the change MUST settle it empirically:

- **Probe/regression test** (Go, in `internal/daemon` or `internal/tmux` test files): on a **private tmux socket** (the house pattern is `-S $(mktemp -d)/s` for ad-hoc probes; in Go tests use the package's `serverSocket` test seam with a unique `-L` name and `t.Cleanup` kill-server; see the `go-test-gate-without-tmux-env` / `tmux-probe-private-socket` notes), birth a server whose environment has `RK_PORT=A` (e.g. a placeholder session created with that env), then from a process whose env has `RK_PORT=B`:
  1. `new-session` **without** `-e` → the new session's pane sees `A` (read via `show-environment -t <session> RK_PORT`, or by running `printenv RK_PORT` in the pane and capturing it). This asserts the hazard.
  2. `new-session` **with** `-e RK_PORT=B` → the pane sees `B`. This asserts the fix mechanism.
  If step 1 shows `B` (the hypothesis is wrong), record that in the plan. The `-e` pass is still kept as defense in depth, but the Why section's claim gets corrected in memory at hydrate.
- **Unit test on `startSession` argv**: via the existing tmux-run seam, assert the `new-session` args carry `-e RK_PORT=<resolved>` when (a) only config.yaml sets the port, (b) the caller's `RK_PORT` overrides config, (c) neither (→ 3000). Isolate config with `RK_CONFIG_DIR` → `t.TempDir()` and `t.Setenv`.
- Run the Go gate as `env -u TMUX -u TMUX_PANE go test ./...` (tests that reach tmux preconditions pass here only because the shell is inside tmux). First-time worktree setup: `just _ensure-tmux-conf` before `go test`.

### 5. Constitution IV amendment

`fab/project/constitution.md` is **currently at v1.14.0** (last amended 2026-09-25). The row's "v1.11.0 → 1.12.0" is stale: the plan row was written before later amendments. Bump **1.14.0 → 1.15.0** (MINOR: a clarified or extended rule, no principle removed) and set `Last Amended: 2026-09-25`.

Reword the configuration sentence of Principle IV so the port reads as a config.yaml key that also keeps its env form, and `RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT` stay the only env forms. Suggested text replacing the current "deployment binding lives in environment variables (…the ONLY keys with env forms)" clause:

> Configuration is layered, and the override order is code default < config.yaml < env < CLI flag: deployment binding lives in environment variables (`RK_PORT`, `RK_HOST`, `RK_CODE_SERVER_PORT` — `.env` committed, `.env.local` for overrides — the bootstrap vehicle, and the ONLY keys with env forms); the daemon port is also a `config.yaml` key (`port`), so an install can pin it durably while `RK_PORT` still wins; per-instance preferences live in `~/.config/run-kit/config.yaml` behind the settings registry; …

The rest of IV is unchanged. Do not touch other principles.

### 6. Docs and specs that state the port is env-only

Present-truth updates only (D11 — history is not rewritten):

- `README.md` and `docs/site/install.md`: where they say "set `RK_PORT`", add the config.yaml form (`port: 4000` in `~/.config/run-kit/config.yaml`, then `rk daemon restart`). **Keep the default stated as 3000**; C5 owns the 6123 flip and the "how to move" release notes.
- `docs/specs/architecture.md` / `docs/specs/api.md`: only if they state that the port is env-only; leave the default value alone.
- `fab/project/context.md` Backend bullet "Config: environment variables (`RK_PORT`, `RK_HOST`) loaded via `.env` / `.env.local`" → mention the `port` config.yaml key and the settings registry.
- `docs/site/skill.md`: only if it tells agents the port is env-only.
- **Out of scope**: the `.env` orphaned `RK_PORT` comment (C5), the default value anywhere (C5), a doctor row (P1 / C4 / C5), the reserved-block warning (P1), `~/.config/hexokit` paths (C4).

### 7. Plan tracker

Update `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` row P3 Status (in progress → PR link at ship). Also correct the row's version text ("v1.11.0 → 1.12.0" → "v1.14.0 → 1.15.0"), since the row is the tracker and should read true.

## Affected Memory

- `run-kit/configuration`: (modify) registry inventory gains `port` (kind `port`, default 3000, `ui: false`, `live: false`, serialize-when-set pin semantics); override order restated with port's three rungs (code default < config.yaml < `RK_PORT`); env forms still only `RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT`; "Deployment binding" row notes that port also has a config home; the 18-key count becomes 19; the `/api/settings` read shape gains a JSON number
- `run-kit/daemon-lifecycle`: (modify) `startSession` passes the resolved `RK_PORT` (and, if chosen, `RK_HOST`/`RK_CODE_SERVER_PORT`) via `-e` beside `RK_DAEMON_LOG`; the born-with-environment rationale and the probe result; `guardPortAvailable` message text
- `run-kit/architecture/cli`: (modify) `serve` / `daemon start` / `daemon restart` help text documents the config key and precedence

## Impact

- **Go backend**: `internal/settings/settings.go` (+ `settings_test.go`, `registry_test.go`), `internal/config/config.go` (+ `config_test.go`), `internal/daemon/daemon.go` (+ tests), `cmd/rk/serve.go`, `cmd/rk/daemon_start.go`, `cmd/rk/daemon_restart.go` help, possibly `api/settings_test.go` (registry rows), `cmd/rk/origin.go` tests (ordering check).
- **Frontend**: expected untouched. The panel filters `ui: false` rows, and `SettingsEntry.value` is `unknown`. Run `just test-frontend` in case a test snapshots the full `/api/settings` row list.
- **E2E**: no behavior change. The harness sets `RK_PORT` explicitly (env wins) and isolates config via `RK_CONFIG_DIR` (no `port` key). No new Playwright test is needed, since there is no UI surface.
- **Docs**: constitution (v1.15.0), README, `docs/site/install.md`, `fab/project/context.md`, possibly specs; plan tracker row P3.
- **Runtime/deployment**: none for existing installs. Nobody has a `port` key, so resolution is identical to today (env or 3000). Side effect of the `-e` pass: after this ships, a `rk daemon restart` from a shell whose `RK_PORT` differs from the server's born-with value **does** move the daemon, where today it would not. That is the intended fix, but mention it in release notes: e.g. a user who once started the daemon from the direnv'd repo with `RK_PORT=3000` and later restarts from a plain shell gets the same 3000 by default, so there is no visible change unless they set something.
- **Security**: none. The port is validated to 1–65535 on both parse and apply. The `-e` value is an integer formatted by `strconv.Itoa` and passed as an argv element (no shell).

## Open Questions

- Pass `RK_HOST` (and an explicitly set `RK_CODE_SERVER_PORT`) via `-e` too, or strictly `RK_PORT`? Recommended: all three, same staleness class; recorded as assumption #15.
- Registry category for `port`: `connectivity` (beside `ssh_host`) or `advanced` (beside `tmux_conf`/`log_level`)? Cosmetic, since `ui: false`.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Add `port` to the `internal/settings` registry, default 3000 — nobody's port changes | Explicit in the user's input and plan row P3; rule P forbids moving anyone here | S:95 R:85 A:95 D:95 |
| 2 | Certain | `RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT` stay the only env forms; `RK_HOST` and `RK_CODE_SERVER_PORT` gain no config key; no `RK_*` rename | User input + plan D2 / rule P; constitution IV | S:95 R:80 A:95 D:95 |
| 3 | Certain | No `rk serve --port` flag in this change; port chain is code default < config.yaml < `RK_PORT` | Asked — user chose "No flag" | S:95 R:85 A:90 D:90 |
| 4 | Certain | `port` registry entry is `ui: false`, `live: false` (file/API only, applies on restart) | Asked — user chose "File/API only" | S:95 R:90 A:90 D:90 |
| 5 | Certain | Constitution bump is 1.14.0 → 1.15.0, not the row's stale 1.11.0 → 1.12.0 | constitution.md footer reads Version 1.14.0; MINOR bump for an extended rule; the row predates later amendments | S:80 R:90 A:95 D:90 |
| 6 | Certain | `RK_CODE_SERVER_PORT` fallback stays `port + 2`, now off the config-resolved port | Explicit in input; `ResolvedCodeServerPort` already derives from `c.Port`, so no code change is needed, only a test | S:90 R:90 A:95 D:95 |
| 7 | Certain | `startSession` always passes `-e RK_PORT=<config.Load().Port>` resolved in the caller at call time, beside `RK_DAEMON_LOG` | User specified `-e` "as the log path already is"; always-passing (not only when env is set) is what defeats a stale born-with value | S:85 R:85 A:80 D:75 |
| 8 | Certain | `internal/config.Load()` reads `settings.Load().Port` as the middle rung; the default lives in one exported constant shared with the registry `def` | Cycle-free import verified via `go list -deps`; single constant avoids a duplicated magic number (code-quality anti-pattern) | S:70 R:85 A:85 D:80 |
| 9 | Confident | `port` serializes whenever explicitly set, including a value equal to the default (0 = unset, omitted) | The key is a pin: C4 writes `port: 3000` and it must survive whole-file `Save` rewrites and C5's default flip; omit-at-default would silently drop it | S:60 R:75 A:80 D:70 |
| 10 | Certain | Born-with-env hypothesis gets a private-socket probe test (hazard without `-e`, fix with `-e`) plus a `startSession` argv unit test | User: "unverified; the change must test it"; house pattern is private sockets, never the live daemon | S:90 R:85 A:80 D:80 |
| 11 | Confident | A config.yaml `port` does not count as "explicit env" in `resolveOrigin`; it rides the `config.Load()` rung below `@rk_srv_origin` | origin.go's rung 1 is defined as caller env; changing it would alter `rk url` inside panes | S:55 R:80 A:75 D:75 |
| 12 | Certain | `guardPortAvailable` message names both homes and keeps the `RK_PORT` substring | Scripts pattern-match `RK_PORT` (documented contract); message should point at the new durable home | S:60 R:90 A:85 D:80 |
| 13 | Certain | Docs keep stating default 3000; only the "how to set it" gains the config.yaml form; `.env` comment, doctor row, and the 6123 flip are left to P1/C4/C5 | Plan sequencing: C5 owns the default and move docs, P1 the doctor/reserved-block rows | S:75 R:90 A:85 D:80 |
| 14 | Confident | GET `/api/settings` reads `port` as a JSON number (null when unset); apply accepts a number in 1–65535, `null` unsets | Natural JSON shape for an integer; the frontend `value: unknown` tolerates it; Constitution IX partial-merge semantics | S:50 R:85 A:75 D:65 |
| 15 | Confident | Also pass `-e RK_HOST=<resolved>` and `-e RK_CODE_SERVER_PORT=<n>` only when an override is set | Same born-with staleness class, costs one `-e` each; row names only port, so plan may narrow to `RK_PORT` | S:40 R:80 A:60 D:55 |
| 16 | Confident | New registry kind `port` (not a generic `int`); category `connectivity` | Only one integer key exists; `connectivity` sits beside `ssh_host`; cosmetic with `ui: false` | S:30 R:90 A:60 D:50 |

16 assumptions (11 certain, 5 confident, 0 tentative, 0 unresolved).
