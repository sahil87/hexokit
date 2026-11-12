---
type: memory
description: "Daemon autostart: `rk daemon autostart on|off|status` registers the daemon with the OS per-user service manager (systemd user unit / LaunchAgent) to start once at boot or login via the login shell — never supervised; shared Backend interface + GOOS registry in internal/daemon/autostart, one self-registering file per OS; Status.Summary() is the shared state line shown by status, rk doctor and a read-only Host system-card row."
---
# Daemon Autostart

**Domain**: run-kit

## Overview

`rk daemon autostart on [--now] | off | status`, each with `--json` (the standard `{ok,result}` envelope), registers the rk daemon with the OS's per-user service manager so it starts **once** at boot or login. The OS never restarts it: a crashed daemon stays down until `rk daemon start`. Off by default. Design and rationale: `fab/plans/sahil/26-11-11-rk-daemon-autostart.md`; spike evidence: `fab/plans/sahil/26-11-11-rk-daemon-autostart-s1-findings.md`.

## Shared surface

- **Package** `internal/daemon/autostart` (`autostart.go`): the `Backend` interface (`On(ctx, OnOptions{Now})`, `Off(ctx)`, `Status(ctx)`), the `Result` (`name`, `path`, `changed`, `started`, `hints`) and `Status` (`platform`, `manager`, `name`, `path`, `registered`, `enabled`, `starts_at` boot|login, `linger` Linux-only, `last_exit_code`, `last_result`, `rk_path`, `shell`, `stale`, `hints`) documents, and a GOOS registry: `Register(goos, ctor)` from each backend file's `init()`, `For(goos)` errors naming the platform when none is registered. No build tags: every backend compiles and tests on any host; the CLI picks one through the `autostartGOOS = runtime.GOOS` seam (`cmd/rk/daemon_autostart.go`, `autostartBackendFn` for tests).
- **Start command**: every registration runs `<login shell> -lc "$(StartScript(rkPath, unsetEnv))"` → `exec [env -u V …] '<rk>' daemon start --if-not-running`. The login shell gives the daemon's tmux server (and every later agent) the environment a manual start from the user's profile would; `--if-not-running` (backed by `daemon.ErrAlreadyRunning`) makes a start against a live daemon a success while real failures stay the job's non-zero exit. `rkPath` is `selfpath.Stable()` — the brew-prefix symlink, never a Cellar keg.
- **Managed marker**: each generated file carries `autostart.ManagedMarker` ("Managed by rk daemon autostart") as a comment; `off` refuses to delete a file at the registration path that lacks it.
- **Invariants**: every verb is idempotent (`changed:false` is "already on/off"); `on` registers only, `--now` also starts through the service manager; `off` never stops a running daemon; every service-manager call is `exec.CommandContext` with a timeout.

## Status summary and visibility

`Status.Summary()` (`autostart.go`) is the one-line autostart state, a method on the platform-neutral `Status` that reads only its fields, never the platform. Five strings (exported `Summary*` constants):

| Summary | Status |
|---|---|
| `on (boot)` | registered, enabled, `starts_at` boot |
| `on (login only — enable lingering for boot)` | registered, enabled, `starts_at` login, `linger` known and off |
| `on (login)` | registered, enabled, any other login case (incl. `linger` null) |
| `registered but disabled` | registered, not enabled |
| `off` | not registered |

Three read-only surfaces print it verbatim:

- **CLI**: `rk daemon autostart status` prints `Autostart: <summary>`.
- **`rk doctor`**: a `daemon autostart` row, always OK-shaped, with note fragments (stale, non-zero last exit, a remediation pointer) or `unavailable — <err>`. See [cli](/run-kit/architecture/cli.md) § `doctor`.
- **Host page**: `GET /api/daemon/autostart` (`api/autostart.go`) returns `{supported, summary, status | error}` and feeds a read-only `autostart` row on the HexoKit system card (mount-time fetch; off reads `off — rk daemon autostart on`; unavailable reads `unavailable — <err>` inline; the row is hidden when the fetch fails). See [api-and-sockets](/run-kit/api-and-sockets.md) and [sidebar](/run-kit/ui/sidebar.md) § HOST HEALTH Zone.

Surfaces never change autostart: enabling or disabling stays `rk daemon autostart on|off`.

## Linux (systemd)

`internal/daemon/autostart/systemd.go` registers for GOOS `linux`. Every package-level identifier carries a `systemd` prefix, because the macOS backend shares the package.

- **Unit**: `hexokit-daemon.service` at `<os.UserConfigDir()>/systemd/user/` (`~/.config/systemd/user/`, honoring `XDG_CONFIG_HOME`), rendered byte-stably:

  ```ini
  # Managed by rk daemon autostart — rewritten by `rk daemon autostart on`, removed by `off`. Do not edit.
  [Unit]
  Description=HexoKit daemon (started once at boot/login, not supervised)

  [Service]
  Type=oneshot
  RemainAfterExit=yes
  KillMode=process
  TimeoutStartSec=90
  ExecStart=<login shell> -lc "exec env -u 'INVOCATION_ID' -u 'JOURNAL_STREAM' -u 'MANAGERPID' -u 'SYSTEMD_EXEC_PID' -u 'MEMORY_PRESSURE_WATCH' -u 'MEMORY_PRESSURE_WRITE' '<rk>' daemon start --if-not-running"

  [Install]
  WantedBy=default.target
  ```

  This is S1's shape L7. `oneshot` plus `RemainAfterExit` makes the unit read `active (exited)` once `rk daemon start` returns. `KillMode=process` means neither `stop` nor a start timeout kills the tmux server the start births. There is no `Restart=` line, ever. `TimeoutStartSec=90` bounds a login profile that blocks; a oneshot unit has no start timeout by default. The `env -u` list strips the variables systemd injects, which would otherwise land in the rk-daemon tmux server's global environment and reach every agent.
- **Quoting**: the `-lc` script is one double-quoted ExecStart word. `systemdEscape` escapes `\` → `\\`, `"` → `\"`, `%` → `%%` (specifiers) and `$` → `$$` (env expansion). Both paths must be absolute, with no control characters and no backslash. A newline would inject unit directives, and fish unescapes backslashes inside single quotes. The shell, which is ExecStart's unquoted first word, must also contain no whitespace or quotes.
- **Login shell**: field 7 of `getent passwd <user>` (covers NSS/LDAP), not `$SHELL`. An empty field means `/bin/sh` (passwd(5)). `$SHELL` is used only when passwd has no entry, and `/bin/sh` is the last resort. A shell that is not executable, or is `nologin` or `false`, makes `on` fail. It is resolved at `on` time, so a later `chsh` shows up as `stale`.
- **Presence check**: `systemctl` on PATH and `/run/systemd/system` present (sd_booted). Otherwise every verb fails with `daemon autostart: systemd not found — on Linux, autostart needs a systemd user manager (systemctl --user)` before running any subprocess.
- **`on`**:
  1. Refuse a file at the unit path that lacks the marker.
  2. Write atomically (`fsatomic`, 0644) only when the bytes differ, then run `systemctl --user daemon-reload`, only after a write.
  3. Run `enable` unless `is-enabled` already says `enabled`. Never `enable --now`.
  4. With `--now`, run `systemctl --user restart` (120 s bound). A bare `start` on an `active (exited)` RemainAfterExit unit is a no-op, while `restart` re-runs ExecStart, and with `--if-not-running` that is a success that touches nothing when the daemon is up.

  `changed` = the file was written or the unit was not yet enabled.
- **`off`**: refuse a marker-less file. Otherwise run `disable` (no `--now`), remove the file, and run `daemon-reload`. It never runs `stop`. When no file exists here but `is-enabled` says `enabled` (a copy on another user-unit search path, often a user manager whose `XDG_CONFIG_HOME` differs from rk's), it runs only `disable` and hints that the other file was left in place. With no file and nothing enabled, it is a `changed:false` no-op.
- **`status`**: each field and its source.
  - `registered`: the file exists and carries the marker. A foreign or unreadable file adds a hint.
  - `enabled`: from `is-enabled`. Its non-zero exit for `disabled`/`not-found` is an answer, not a failure.
  - `last_result` / `last_exit_code`: from `systemctl --user show -p Result -p ExecMainStatus -p ExecMainStartTimestampMonotonic`. Both are empty or null when the start timestamp is 0, because `Result` reads `success` even for a unit that never ran.
  - `linger`: from `loginctl show-user <user> -p Linger --value`. It is null when logind can't answer, with a hint.
  - `starts_at`: `boot` when registered, enabled and lingering; `login` when lingering is off or unknown.
  - `stale`: a fresh render differs from the file. A moved rk path or a `chsh` surfaces here, with a re-run-`on` hint.
  - Hints: `loginctl enable-linger <user>` when lingering is off, plus the per-shell profile caveat. zsh reads `~/.zprofile`, not `~/.zshrc`; bash reads `~/.bash_profile`/`~/.profile`, not `~/.bashrc`. PATH, credentials and `TMUX_TMPDIR` exports belong in the login profile, since an rc-only `TMUX_TMPDIR` splits the tmux socket path.

  A failing probe degrades its field instead of failing the verb.
- **Timing**: with lingering, the unit runs at boot. Without it, the user manager starts the unit at the user's first login, and stopping that manager at the last logout tears the daemon down even under `KillMode=process`. `on` never enables lingering, because that is a privileged one-time step. `status` prints the command instead.
- **Seams**: the `systemd` struct holds `run` (argv + per-call timeout: 10 s systemctl, 5 s loginctl/getent, 120 s restart), `configDir`, `username`, `lookPath`, `booted`, `rkPath`, `getenv` and `executable`. Tests drive all three verbs with a fake runner and a temp config dir, so no real systemctl, loginctl or getent runs.
- **Not yet exercised on a real machine**: `on`, `off` on an active unit, lingering and a reboot. That is plan step A5, run with the user.

## macOS (launchd)

`internal/daemon/autostart/launchd.go` registers for `darwin`. It is a per-user **LaunchAgent** in the `gui/<uid>` domain, so `starts_at` is always `login`: a boot-time LaunchDaemon would run as root.

- **Identity**: label `ai.shll.hexokit.daemon`; plist `~/Library/LaunchAgents/ai.shll.hexokit.daemon.plist`; service target `gui/<uid>/ai.shll.hexokit.daemon`.
- **Plist**: the `ManagedMarker` comment; `ProgramArguments = [<login shell>, -lc, StartScript(rkPath, nil)]`; `RunAtLoad` and `AbandonProcessGroup` true; **no `KeepAlive`**; stdout and stderr go to `<state home>/logs/autostart.log` (`apphome.LogsDir()`). It is rendered by hand with `encoding/xml` text escaping, so the output is byte-stable and `stale` is a plain byte comparison.
- **Login shell**: `dscl . -read /Users/<user> UserShell`, falling back to `/bin/zsh`. `$SHELL` is never read.
- **`on`**:
  - Ensures `~/Library/LaunchAgents` and the logs dir exist on every run. launchd does not create the log file's directory, and a missing one fails the job before the shell starts.
  - Writes the plist only when it differs.
  - Runs `launchctl enable <service>`, which clears a stale disable override and neither loads nor starts the job.
  - Never bootstraps without `--now`. With `--now`:
    - not loaded → `bootstrap gui/<uid> <plist>` (`RunAtLoad` runs it);
    - loaded with a changed plist → `bootout` then `bootstrap`;
    - loaded and unchanged → `kickstart <service>` (no `-k`).
  - Refuses to overwrite a plist that lacks the marker.
- **`off`**: refuses a foreign plist, otherwise `bootout` if loaded and delete the plist. It never stops the daemon: the job's shell has already exited after its single run, and the tmux server lives in its own session.
- **`status`**:
  - `enabled` comes from `launchctl print-disabled gui/<uid>`; `=> disabled` (macOS 13+) and `=> true` (older releases) both count as disabled.
  - `last_exit_code` / `last_result` are parsed from `launchctl print <service>`'s `last exit code = N[: signal]` line. `(never exited)` → `never run`; an unknown service → `not loaded`.
  - A foreign plist reports `registered: false` with a hint to remove it.
  - Hints cover: disabled, stale, a failed last start (naming the log), and for zsh/bash the profile-vs-rc caveat (`~/.zprofile` but not `~/.zshrc`; `~/.bash_profile` but not `~/.bashrc`). fish gets no caveat because it reads `config.fish` for login shells.
- **Seams**: one `run(ctx, name, args…) → (out, exitCode, err)` (production: `exec.CommandContext`, 10 s timeout), plus `homeDir`, `uid`, `username`, `rkPath` and `logsDir` fields. Tests drive every verb on Linux with a recording fake and `t.TempDir()` homes.
- **Desktop app**: it does not expose the switch. Starting from both the app and launchd ends with one daemon: `rk daemon start` refuses a second one and the agent's `--if-not-running` reads that as success. A start race between the two can still record a non-zero `last exit code` while the daemon ends up running.
- **Unverified on a real Mac** (A5's checklist, from S1 § macOS and review):
  - the tmux server outliving the job, with and without `AbandonProcessGroup`;
  - `bootout` leaving the daemon running;
  - the `zsh -lc` environment diff against a manual start;
  - the tmux socket path under the agent's `TMPDIR`;
  - no second daemon on a second login;
  - an intermittent `Bootstrap failed: 5: Input/output error` right after a `bootout`;
  - `launchctl enable` failing in an SSH-only session that has no `gui/<uid>` domain.

## Design Decisions

#### Autostart is surfaced as a read-only status line, not a settings toggle
**Decision**: The UI shows autostart as a read-only row on the HexoKit system card fed by `GET /api/daemon/autostart`; there is no settings-registry key, toggle, POST route, or palette action.
**Why**: Autostart state lives in the OS service manager, not `config.yaml` — a registry key would be a drifting second copy; the HOST HEALTH zone is read-only by contract; turning autostart on is a deliberate CLI opt-in (off by default; lingering needs a privileged step a toggle cannot take).
**Rejected**: A `daemon_autostart` settings-registry entry with an apply hook (second source of truth, mutates host state from a read-only zone, remote one-click enable); a card toggle + palette action (same remote-enable concern).
*Introduced by*: 261111-whzt-daemon-autostart-visibility

#### One `Status.Summary()` feeds CLI, doctor and UI
**Decision**: The state vocabulary is a method on `autostart.Status`; the CLI status text, the doctor row and the API's `summary` all call it.
**Why**: Three surfaces must say the same thing; keying the lingering clause on `Linger != nil` rather than the platform keeps every backend (macOS included) working with no surface change.
**Rejected**: Deriving the label separately in the frontend from raw fields (a second copy of the rules in TypeScript).
*Introduced by*: 261111-whzt-daemon-autostart-visibility

#### Linux unit name `hexokit-daemon.service`
**Decision**: The systemd user unit is `hexokit-daemon.service`.
**Why**: `off` must find the unit forever. The product name (the `hexokit` state/config homes and brew keg) is stable, while the binary name has drifted (rk ↔ run-kit). `rk-daemon` already names the tmux socket and session.
**Rejected**: `rk-daemon.service`, which is ambiguous next to the tmux socket/session of the same name and tied to the binary name.
*Introduced by*: 261111-rreg-linux-daemon-autostart-systemd

#### `--now` re-runs the oneshot with `systemctl --user restart`
**Decision**: `on` registers only. `--now` adds `restart`.
**Why**: A bare `start` on an already `active (exited)` RemainAfterExit unit does nothing, while `restart` re-runs ExecStart. Under `KillMode=process` with `--if-not-running`, S1 verified that a restart with the daemon up kills nothing and reads as success.
**Rejected**: `enable --now` / `start` (a silent no-op on an active unit); starting by default (gives `on` side effects and breaks the symmetry with `off` never stopping).
*Introduced by*: 261111-rreg-linux-daemon-autostart-systemd

#### Idempotent start flag instead of grepping status text
**Decision**: Registrations run `rk daemon start --if-not-running`, backed by the `daemon.ErrAlreadyRunning` sentinel.
**Why**: `rk daemon start` exits 1 against a live daemon, and `rk daemon status` exits 0 either way. S1's L7 worked around that with `start || status | grep "^Daemon: *running"`, which ties the unit to display text. The flag keeps L7's semantics (success when the daemon is up, failure when rk is missing) without depending on output text.
**Rejected**: L7's grep (couples the unit to display text); `ExecStart=-…` (S1's L6, which hides real failures such as a missing rk).
*Introduced by*: 261111-rreg-linux-daemon-autostart-systemd

#### Login shell from passwd, resolved at `on` time
**Decision**: The Linux backend takes the shell from `getent passwd` field 7, writes it as an absolute path, and reports drift as `stale`.
**Why**: `$SHELL` reflects whatever shell ran rk, not the account's login shell. An absolute path can be validated (executable, not `nologin`/`false`, unquoted-safe) and compared byte-for-byte in `status`.
**Rejected**: systemd's `%s` specifier, which follows `chsh` automatically but can't be validated or reported, and silently runs a `nologin` shell; `$SHELL`, which is the wrong source.
*Introduced by*: 261111-rreg-linux-daemon-autostart-systemd

#### Bootstrap only with --now on macOS
**Decision**: `on` writes and enables the LaunchAgent. Only `on --now` runs `launchctl bootstrap` (or `kickstart` when the job is already loaded).
**Why**: With `RunAtLoad`, a bootstrap runs the job immediately, so an unconditional bootstrap would start the daemon on every `on`, breaking the shared "register only unless `--now`" contract. launchd loads `~/Library/LaunchAgents` at login anyway.
**Rejected**: Bootstrapping on every `on`, which is the plan brief's literal wording.
*Introduced by*: 261111-qdxp-macos-daemon-autostart-launchagent

#### Shared surface as one byte-identical commit, backends self-register
**Decision**: The platform-neutral code (the interface, documents, registry, CLI and start script) ships as one commit carried unchanged by both platform PRs. Each backend lives in its own file, registers from `init()`, prefixes every package-level identifier with its manager name (`launchd…`, `systemd…`), and uses no build tags.
**Why**: The Linux and macOS backends were built in parallel. With an identical shared commit, whichever PR merges second drops it on rebase (same patch-id). Self-registration keeps each PR compiling on its own. Prefixed names keep the two files from colliding inside one package. Without build tags, both backends are tested on Linux CI.
**Rejected**: `_darwin.go`/`_linux.go` build tags, because the macOS backend would then never compile or run in CI. A shared selector that names both constructors, because each PR would fail to compile without the other.
*Introduced by*: 261111-qdxp-macos-daemon-autostart-launchagent
