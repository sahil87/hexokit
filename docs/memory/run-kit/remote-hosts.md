---
description: "SSH-only remote hosts — the `rk remote` six-verb family (add/connect/list/status/disconnect/remove, no `update`) over `internal/remote`: remotes.yaml v1 with immutable 3100–3199 ports (rule P move to 21500–21599 deferred), an `ssh -N -L` tunnel window per remote in the `rk-remotes` session on the rk-daemon socket, idempotent connect (installer bootstrap, older-than-local update, daemon start, origin via `rk url`), loopback binding with SSH as sole auth, read-path validation of stored entries."
type: memory
---
# SSH-Only Remote Hosts (`rk remote`)

**Domain**: run-kit

## Overview

A machine reachable **only over SSH** — a cloud VM, a work box behind a bastion, anywhere a mesh VPN cannot be installed — becomes a full rk host through `rk remote`: the VS Code Remote-SSH model. rk bootstraps itself onto the box over the existing SSH channel, runs the daemon there, and holds a local `ssh -L` tunnel so the dashboard answers at a stable local origin (`http://127.0.0.1:<port>`) that the desktop shell and a plain browser both treat as an ordinary host.

This **complements Tailscale rather than replacing it**: the tunnel exists only where the ssh client runs, so there is no mobile access. Tailscale remains the answer for reaching a host from a phone.

The **CLI owns bootstrap and tunnel lifecycle** — not the Electron shell. That keeps the shell a viewer that only runs user-initiated `rk` commands (see [desktop-shell](/run-kit/desktop-shell.md) § SSH Remote Hosts) and makes the feature fully usable from a bare terminal plus a browser, with no shell installed at all. There are no HTTP endpoints for any of it; the shell reaches the subsystem through `execFile`, so Constitution IX is not in play.

Code: `app/backend/cmd/rk/remote.go` (the command surface) over `app/backend/internal/remote/` (`store.go`, `name.go`, `ports.go`, `ssh.go`, `tunnel.go`, `connect.go`, `status.go`).

## Requirements

### Requirement: Six verbs, no `update`
`rk remote` MUST expose exactly six subcommands — `add <target>` (`--name`, `--local-port`), `connect <name|target>`, `list`, `status <name>`, `disconnect <name>`, `remove <name>` — registered on `rootCmd` in `root.go`. There is **no `update` verb**: update is folded into `connect`, which is idempotent and upgrades the remote as part of getting in.

| Verb | Behavior |
|------|----------|
| `add <target>` | Pure local registration — no ssh roundtrip. Stores the target verbatim, derives the name, assigns the local port, prints `Name:`/`Target:`/`Local:` data lines. |
| `connect <name\|target>` | The one idempotent get-in flow (probe → bootstrap → update-if-older → remote daemon → derive origin → tunnel → readiness). Final stdout line is the local origin. |
| `list` | `NAME / TARGET / LOCAL / TUNNEL / REMOTE DAEMON` via `tabwriter`; tunnel state from tmux, daemon state from an ssh probe per remote. |
| `status <name>` | Single-remote detail plus version skew (older → connect will update it; newer → left untouched). |
| `disconnect <name>` | Kills only that remote's tunnel window. The remote daemon keeps running. |
| `remove <name>` | Disconnect, then drop the entry. The remote installation is untouched. |

Nested arg validators are re-wrapped with `usageArgs` in `remote.go`'s `init()` (the `desktop.go` idiom) because `root.go`'s central wrap loop covers only `rootCmd`'s direct children.

#### Scenario: The command tree carries no update verb
- **GIVEN** a built `rk` binary
- **WHEN** `rk remote --help` runs
- **THEN** the six subcommands are listed and `rk remote update` is an unknown command
- **AND** `rk help-dump` includes the whole `remote` subtree (the cobra walk picks it up; every node carries a `Long:` block)

### Requirement: State is `~/.config/rk/remotes.yaml` v1 carrying only the underivable
The store MUST be schema `version: 1` with entries of exactly `{name, target, local_port}` — the only facts that cannot be derived while disconnected. Load treats a missing file as an empty v1 list; malformed YAML or an unknown version is an error, never a silent rewrite. Save is atomic via the shared `internal/fsatomic.WriteFile` (tmp file in the target dir then rename, `0o755` dir / `0o644` file). Tunnel up/down, remote daemon state, the remote port, and version skew are all derived at request time — no pid files, no supervisor (Constitution II).

```yaml
version: 1
remotes:
  - name: buildbox            # display + tmux window name + lookup key
    target: sahil@buildbox    # verbatim ssh arg — alias or user@host, never parsed
    local_port: 3100          # assigned once at add-time, then immutable
```

`Find(nameOrTarget)` resolves a reference name-first then by verbatim target; `Remove(name)` returns the pruned file plus whether anything was dropped.

### Requirement: Local ports come from 3100–3199 and never move
`AssignPort` MUST pick the **lowest** port in `[PortRangeStart, PortRangeEnd]` = 3100–3199 — the range is sourced from the port policy (`internal/remote/ports.go`'s `PortRangeStart`/`PortRangeEnd` are package vars aliasing `portpolicy.Tunnel`) — that no `remotes.yaml` entry holds and no live listener occupies (live set from `ports.ListeningNow` at the cmd boundary). The port policy's rule P targets 21500–21599 for this block, but the move is deferred: `PORTPOLICY_TUNNEL_START`/`PORTPOLICY_TUNNEL_END` stay 3100/3199, and `internal/portpolicy/ports.env` carries a comment above them recording the target range and the deferral reasons (rationale in § Design Decisions). An explicit `--local-port` MUST fall inside the range and pass the same two collision checks. Once assigned the port is **immutable** — no code path reassigns it, because the stable origin is what keeps per-origin browser state (theme accent, terminal font) and the desktop shell's persistent view identity alive across launches.

#### Scenario: Auto-assignment skips both store entries and live listeners
- **GIVEN** entries on 3100 and 3101 and a live listener on 3102
- **WHEN** a new remote is added
- **THEN** it is assigned 3103
- **AND GIVEN** `--local-port 3050`, add errors naming the 3100-3199 range

### Requirement: Names derive offline from the target's host token
`DefaultName(target)` MUST take the text after the last `@` (a bare alias is its own host token), map dots to hyphens (tmux names cannot carry periods — `build.example.com` → `build-example-com`), and validate the result. A target whose derivation still fails validation errors with a pointer to `--name`. The derivation is pure and offline: `add` performs no ssh roundtrip, so the health-ping hostname the desktop shell uses for URL hosts is not available here.

### Requirement: Tunnels are tmux windows in a sibling `rk-remotes` session
Tunnel processes MUST live in tmux on socket `rk-daemon` (`daemon.ServerSocket`), session `rk-remotes` (`remote.SessionName`), one window per remote named for the remote, running exactly:

```
ssh -N -o BatchMode=yes -o ServerAliveInterval=15 -L 127.0.0.1:<lp>:127.0.0.1:<rp> <target>
```

The command is passed as **argv elements** — tmux ≥3.4 executes a multi-argument shell-command directly, without a shell, so nothing is string-interpolated. Session creation uses exact-match targets (`=rk-remotes`) and pins CWD to `tmux.ServerBirthDir()` when it births the tmux server (the server-birth seam rule — a browser-only user with no local daemon still tunnels, and rk's own CWD may be a later-deleted worktree). Tunnel state is derived per request from one `list-windows -F '#{window_name}\t#{pane_current_command}'` call; a missing session or absent tmux server is the empty map (all down), never an error. There is no supervisor and no auto-reconnect — the one caller-scoped exception is `rk daemon restart --full`, which captures the up-set (`Load` ∩ `ListTunnels`) before killing the whole rk-daemon server and re-runs the idempotent `Connect` for exactly those remotes after the fresh start (user-initiated, one-shot; per-remote failures warn and never fail the restart — see [daemon-lifecycle](/run-kit/daemon-lifecycle.md) § Daemon Lifecycle → `--full` semantics).

Placing tunnels on the **rk-daemon** socket makes them invisible to the dashboard's user-session enumeration and independent of the daemon's own lifecycle: `rk daemon stop` kills only `=rk-daemon`, never a tunnel. The explicit `rk daemon restart --full` whole-server kill is the exception, and it reconnects the previously-up tunnels itself.

The same `-L` forward also carries the desktop shell's web-tile tunnel WebSockets: the shell's `proxy` web mode terminates Chromium's proxy protocol at a desktop-local loopback listener and tunnels each connection to the remote rk's `GET /ws/tunnel` endpoint through the viewer-side tunnel origin `http://127.0.0.1:<lp>` ([api-and-sockets](/run-kit/api-and-sockets.md) § Tunnel, [desktop-shell](/run-kit/desktop-shell.md) § Web Views → Per-host proxy modes) — no new forward and no second exposed port.

#### Scenario: A dead tunnel reads as down and heals via connect
- **GIVEN** a connected remote whose window is killed externally
- **WHEN** `rk remote list` runs
- **THEN** the TUNNEL column reads `down` (state derived, nothing stored)
- **AND** the next `rk remote connect` reopens the window

### Requirement: `connect` is the one idempotent get-in flow
`Connect` MUST run, in order: (1) ssh-probe `rk --version`; (2) bootstrap via the project's standard public installer over ssh exec — the fixed literal `curl -fsSL https://shll.ai/install | sh -s -- run-kit` — when rk is missing; (3) re-run that same installer when the remote rk is **older** than local; (4) `rk daemon start` on the remote, where both `daemon already running` and `already serving on` count as success; (5) derive the remote origin via `ssh <target> rk url` and take its port for the `-L` spec; (6) squatter-check, then ensure the tunnel window is up; (7) wait for the local forward to accept TCP. Progress lines go to the chatter channel; the local origin is the final stdout data line.

Every remote command is a fixed literal prefixed with `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin"`, because ssh exec runs a non-interactive (usually non-login) shell whose PATH often misses the Homebrew/linuxbrew bins that hold `rk` and the `tmux` the remote `rk daemon start` needs.

`Connect` opens with a **local tmux floor gate** before any ssh roundtrip: the local tmux version is probed via the `tmuxVersionFn` seam (= `tmux.CurrentVersion`, a 5s `tmuxVersionProbeTimeout`), and a parsed version below tmux 3.4 refuses the whole flow with an error carrying the found version plus the shared `tmux.UpgradeHint` remediation (`remote tunnels: {message}`) — no ssh probe, no tunnel. Unknown (unparseable) versions pass through — never block on a parse. The gate exists because only tmux ≥ 3.4 execs a multi-argument shell-command without a shell (rationale in § Design Decisions).

A re-connect of a fully healthy remote re-runs steps 4–5 as verification (`rk daemon start` classified as an already-up no-op; `rk url` a pure read) and reprints the origin — it installs nothing and opens no second window. Deriving the origin per connect is mandatory: Constitution II forbids storing it.

#### Scenario: A cold box is bootstrapped end to end
- **GIVEN** a registered remote with no rk installed
- **WHEN** `connect` runs
- **THEN** the installer runs over ssh, the daemon starts, the tunnel opens, and stdout ends with `http://127.0.0.1:<lp>`

### Requirement: Version skew never downgrades
The skew baseline is the **local** rk version. `VersionOlder` (via `updatecheck.AnyIncrease` over the parsed semver tokens) is the only direction connect acts on, since the installer installs latest. A **newer** remote is left untouched and merely noted in `rk remote status`. A local `dev` (non-ldflags) build cannot anchor a comparison, so it skips the auto-update entirely; an unparseable version on either side is likewise "no actionable skew".

### Requirement: BatchMode-only auth with an actionable failure
Every ssh invocation MUST carry `-o BatchMode=yes`; probe/bootstrap invocations additionally carry `-o ConnectTimeout=5` (the tunnel command stays byte-exact as specified above). `StrictHostKeyChecking` is untouched — no `accept-new`, no weakening of host-key verification. ssh's own exit 255 classifies as an ssh-level failure, and the error carries the last five non-empty stderr lines plus the hint to run `ssh <target>` once from a terminal (that is where key setup and host-key trust belong). v1 has no interactive auth: password/2FA prompts are out, replaced by that error.

#### Scenario: A target without non-interactive auth fails fast
- **GIVEN** a target with no key set up
- **WHEN** `connect` runs
- **THEN** it fails with ssh's stderr tail and the `ssh <target>` hint, and never prompts

### Requirement: A foreign squatter errors; the port is never reassigned
When the assigned local port already accepts connections but the remote's tunnel window is NOT up, `connect` MUST fail with an error naming the port and the squatting situation, leaving `remotes.yaml` unchanged. Port immutability and the stable-origin rationale exclude silent reassignment.

### Requirement: Loopback-only remote binding, SSH as the sole auth layer
The remote daemon binds `127.0.0.1` for these hosts — nothing is exposed on the remote's network interfaces and rk grows no auth story of its own. The remote origin and port are **derived at connect time** via `ssh <target> rk url` and never persisted (Constitution II).

### Requirement: Stored entries are validated on the read path
`remotes.yaml` is a **user-editable input boundary**, and every verb feeds stored names into tmux argv and stored targets into ssh argv. `Load` therefore re-validates every entry (`validateEntries`) and rejects the whole file before any stored value can reach a subprocess — add-time validation alone would let a hand-edited `-oProxyCommand=…` target through. `validateEntries` also rejects a `local_port` outside the reserved range, so a hand-edited or future-stale entry fails at Load with a fix-or-remove message rather than loading unchallenged. Load is the single seam every verb reads through, so `connect`/`disconnect`/`remove`/`list`/`status` all inherit the guard.

`validate.ValidateRemoteName` layers remote-seam hardening over the shared tmux-safe `ValidateNewName` rule: no leading `-` (would read as a flag), no `/` (corrupts tmux target syntax). `validate.ValidateRemoteTarget` applies the `ValidateSSHHost` rules (no whitespace or control characters, no double quotes, DNS-bounded length) plus the same leading-`-` rejection, so a hostile target can never be parsed as an ssh option.

#### Scenario: A hostile stored target reaches no subprocess
- **GIVEN** a hand-edited entry whose target is `-oProxyCommand=touch /tmp/pwned`
- **WHEN** `connect` runs against it
- **THEN** `Load` rejects the file and zero ssh or tmux calls are made

### Requirement: Principle 9 data-vs-chatter split on the whole surface
Every verb routes output through the shared `outputSink` (`newSink(cmd)`). Stdout carries data that survives `--quiet`: add's `Name:`/`Target:`/`Local:` lines, connect's final origin line, the list table, status's labeled report, and disconnect/remove's outcome lines. Stderr carries chatter that `--quiet` drops: connect's progress lines, add's `Already registered.` / `Next: rk remote connect <name>` hints, and the installed/updated notes. See [toolkit-standards](/run-kit/toolkit-standards.md) § A new command surface is checked against help-dump and Principle 9.

## Known Gaps

**Known gap — a lingering dead window can produce a duplicate.** `openTunnel` gates on `TunnelUp`, which requires the window's pane command to start with `ssh`. Under a tmux config carrying `remain-on-exit on`, a window whose ssh has exited stays present with a dead pane, so `TunnelUp` reads false and `new-window -n <name>` creates a **second** window with the same name. `disconnect`/`remove` then kill via the exact-match `=name` target, which resolves to only one of the pair — the other survives as an orphan. The repo's own `config/tmux.conf` does not set `remain-on-exit`, so the default posture is unaffected.

**Known gap — `connectRemoteHost` ignores connect's `notInstalled` flag.** The welcome flow's `rk remote add` leg branches on `added.notInstalled` to say "HexoKit is not installed on this machine", but the subsequent streaming `rk remote connect` leg does not — an ENOENT there surfaces as the generic error text instead of the same actionable message. In practice the add leg would already have caught a missing binary, so the path is near-unreachable.

**Known gap — the heal reload uses the attach-time `lastPath`.** `ensureRemoteConnected` closes over the host record captured when the view was attached, so a successful background heal reloads `host.url + (host.lastPath ?? "")` rather than wherever the view has since navigated. A view whose load failed is usually still sitting on its error page, so the captured path is normally the right target; a user who navigated after the failure would be sent back.

## Design Decisions

### The CLI owns bootstrap and tunnels, not the shell
**Decision**: The six-verb `rk remote` family in the Go CLI owns registration, bootstrap, and tunnel lifecycle; the Electron shell only invokes it via `execFile`.
**Why**: Preserves the shell's viewer discipline (it never initiates process work of its own — see [desktop-shell](/run-kit/desktop-shell.md) § Design Decisions → Viewer shell, not a bundled daemon), and makes the whole feature usable from a plain terminal plus a browser with no shell installed.
**Rejected**: Implementing tunnels in the shell's main process — it would strand terminal-only users and duplicate the ssh orchestration in TypeScript.
*Introduced by*: 260801-35gv-ssh-remote-hosts

### The system `ssh` binary, never a bundled SSH library
**Decision**: Tunnels and probes shell out to the system `ssh`.
**Why**: Inherits the user's entire existing trust setup for free — `~/.ssh/config` aliases, agent auth, ProxyJump, ControlMaster — rather than inventing an rk auth story or reimplementing SSH.
**Rejected**: A Go SSH library (would need its own key/agent/config/jump-host handling and would diverge from what `ssh <target>` does on the same machine).
*Introduced by*: 260801-35gv-ssh-remote-hosts

### Tunnels live on the rk-daemon socket, in a sibling session
**Decision**: Tunnel windows sit in session `rk-remotes` on socket `rk-daemon`, not on the agent-session `runkit` server and not as children of the CLI process.
**Why**: The rk-daemon socket is the infrastructure socket the dashboard never enumerates, so tunnels stay invisible as "sessions"; a sibling session makes `kill-session =rk-daemon` (daemon stop) harmless to tunnels and lets a browser-only user with no local daemon still tunnel; and window presence plus pane command is derivable state (Constitution II), so no pid file or supervisor is needed.
**Rejected**: Child processes of the CLI (die with the invoking command), a supervisor loop (Constitution II forbids it — a dead tunnel is visible in `list` and heals via the idempotent `connect`), and windows on the user-visible `runkit` server (infrastructure noise in the dashboard).
*Introduced by*: 260801-35gv-ssh-remote-hosts

### Update folds into connect; there is no `update` verb
**Decision**: `connect` detects skew and re-runs the installer itself; no `rk remote update` exists.
**Why**: Connect is already the idempotent get-in flow, and "get me in" always implies "on a version that works" — a separate verb would be a step users forget until something breaks.
**Rejected**: A dedicated `update` verb (a seventh command whose only job is a step connect must take anyway).
*Introduced by*: 260801-35gv-ssh-remote-hosts

### Skew is measured against local, and only upward
**Decision**: The baseline is the local rk version; connect re-runs the installer only when the remote is **older**, and leaves a newer remote alone with a note in `status`.
**Why**: The installer installs *latest*, so "remote is older" is the only direction it can act on; downgrading a remote to match an old local would be a destructive surprise, and a local `dev` build is incomparable so it skips the decision entirely.
**Rejected**: Pinning the remote to the local version (needs a version-targeting installer that does not exist, and downgrades), and treating any difference as actionable (would thrash a deliberately-ahead remote).
*Introduced by*: 260801-35gv-ssh-remote-hosts

### The local port is assigned once and never moves
**Decision**: A port from 3100–3199 is chosen at add-time against both the store and live listeners, then fixed for the remote's lifetime; a squatter at connect time is an error, not a reassignment.
**Why**: The local origin is an **identity** — per-origin browser state (theme accent, terminal font, localStorage) and the desktop shell's persistent per-host view all key on it, so a moving port silently resets the host's whole experience. The reserved range is owned by the port policy (`internal/portpolicy/ports.env` — the `rk remote add --local-port` help text derives its stated range from it) and stays clear of the dev ports and the machine-only rig block.
**Rejected**: Ephemeral ports per connect (new identity every session) and silent reassignment on collision (same effect, hidden).
*Introduced by*: 260801-35gv-ssh-remote-hosts

### The tunnel range stays 3100–3199; the rule P move to 21500–21599 is deferred
**Decision**: `PORTPOLICY_TUNNEL_START`/`PORTPOLICY_TUNNEL_END` stay 3100/3199. The rule P target range 21500–21599 and the deferral reasons live as a comment in `internal/portpolicy/ports.env`. A possible later shape — new remotes assigned from 21500+ with existing entries grandfathered — is recorded but undecided.
**Why**: `Remote.LocalPort` is immutable by design — the origin keys per-origin browser state and the desktop shell's persistent view identity, so reassigning a stored port silently resets the host's experience. A live `ssh -L` tunnel window would keep forwarding on the old port while the store points at the new one, orphaned. And `remote.Load`'s `validateEntries` rejects out-of-range entries, so a range move without a data migration makes Load reject every existing `remotes.yaml` outright. A one-shot reassignment is therefore not the trivial fix the port-policy plan allowed for.
**Rejected**: One-shot reassignment of persisted `local_port`s in `Load` (collides with port immutability and orphans live tunnels).
*Introduced by*: 260926-qm4d-hexokit-home-migration

### Pure core, impure shell, seam-var injection
**Decision**: `internal/remote` keeps its decision logic pure (port assignment, name derivation, output parsing, skew decision all take explicit inputs) and isolates subprocess work behind package-level seam vars — `runCmdFn` for ssh, `tmuxRunFn`/`tmuxOutputFn` for tmux, `dialFn` for TCP readiness — with the live-listener read wired at the cmd boundary through `liveTCPPortsFn`.
**Why**: Matches the repo's established test idiom (`findPortOwner`/`innerServePIDFn`, `readListeningPortsFn`), so the whole orchestration — bootstrap, update, squatter, auth failure, idempotent re-connect — is testable with no network and no tmux.
**Rejected**: Spinning up the `ports.Collector` for a one-shot read (goroutine and poll machinery for a single enumeration — hence the exported `ports.ListeningNow`), and interface-based injection (heavier than the codebase's seam-var convention).
*Introduced by*: 260801-35gv-ssh-remote-hosts

### Labeled stdout lines are the shell↔CLI contract
**Decision**: `rk remote add` emits `Name:`/`Target:`/`Local:` labeled stdout lines and `connect` emits the origin as its final stdout line; the desktop shell parses both in an electron-free pure module (`app/desktop/src/remote-host.ts`).
**Why**: Follows the `rk desktop status` → `update-check.ts` precedent — stable labeled data lines under the existing Principle 9 stdout discipline, with no new flag surface added for a single internal consumer.
**Rejected**: `--json` flags on these verbs (new public surface and help-dump churn for one consumer) and re-deriving the name in TypeScript (the same derivation logic duplicated across two languages).
*Introduced by*: 260801-35gv-ssh-remote-hosts

### Tunnel readiness is a TCP dial, not an HTTP probe
**Decision**: After the window is up, connect polls `net.DialTimeout` against `127.0.0.1:<lp>` at a 300ms cadence with a 15s budget, failing early when the window disappears mid-wait.
**Why**: ssh starts listening on the forward once authenticated, so a dial is the narrowest signal that the tunnel itself is live; it consumes no HTTP request and stays honest about what it is testing (the forward, not the remote server).
**Rejected**: An HTTP `/api/health` probe (conflates tunnel readiness with remote-server health, and the shell already health-pings separately before persisting a host) and pane-output scraping (brittle).
*Introduced by*: 260801-35gv-ssh-remote-hosts

### Remote commands are fixed literals with a PATH prefix
**Decision**: Every remote command string is a compile-time literal prefixed with `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin"`; only the target rides as its own argv element on the ssh invocation.
**Why**: Nothing user-provided is ever interpolated into a remote command (Constitution I), and the prefix fixes the remote-side mirror of the GUI-PATH trap the desktop shell's `augmentPath` solves — an ssh non-login shell otherwise cannot find a brew-installed `rk`, nor the `tmux` that the remote `rk daemon start` needs.
**Rejected**: Building remote commands by interpolation (injection surface), and requiring users to fix their remote shell's PATH (a support burden for a trap rk creates for itself).
*Introduced by*: 260801-35gv-ssh-remote-hosts

### Connect hard-refuses below the tmux 3.4 floor — the one version gate
**Decision**: `Connect` probes the LOCAL tmux version at entry (before any ssh) and refuses below 3.4 with an actionable error naming the found version plus the shared brew-first upgrade hint; unknown versions pass through, and every other surface (daemon start, `rk serve`, doctor) only warns.
**Why**: the tunnel window's ssh command rides tmux as a multi-argument shell-command, and only tmux ≥ 3.4 execs it as argv without a shell — below the floor tmux shell-joins the arguments, string-interpolating the remote target through a shell (Constitution I). The local tmux is what executes the tunnel argv, so the local version is the security-relevant probe.
**Rejected**: warn-and-continue like the other surfaces (below-floor here is a security regression, not a degraded experience); probing the remote's tmux (remote commands are fixed literals — the interpolation exposure is local-side).
*Introduced by*: 260819-vtd1-tmux-version-floor

## Testing

`app/backend/internal/remote/*_test.go` drives every seam without a network or a tmux server: `store_test.go` (round-trip, missing file, bad version, hostile stored entries, out-of-range `local_port` rejection), `name_test.go`/`ports_test.go` (pure derivation and assignment, including range exhaustion), `ssh_test.go` (argv shape, fixed-literal-with-PATH-prefix assertion, classifiers, version parse, all three skew directions, `rk url` port parse), `tunnel_test.go` (byte-exact tunnel argv, state parse, session-birth CWD pin, targeted idempotent close, readiness branches with shrunken poll vars), and `connect_test.go` (bootstrap, update-only-when-older, squatter, auth failure, idempotent re-connect, the zero-subprocess proof for a hostile stored target, and the tmux floor gate — below-floor refuses before any ssh, unknown and at-floor pass through). `app/backend/cmd/rk/remote_test.go` covers the command surface itself — the six verbs, absence of `update`, add flow shapes and idempotency, collisions, range errors, unknown-remote errors, and `--quiet` keeping the data lines. The desktop side's parsing lives under `node --test` in `app/desktop/src/remote-host.test.ts`.
