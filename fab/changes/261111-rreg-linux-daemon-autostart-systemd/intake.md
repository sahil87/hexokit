# Intake: Linux daemon autostart (systemd user unit)

**Change**: 261111-rreg-linux-daemon-autostart-systemd
**Created**: 2026-11-11

## Origin

> Implement step A1 of fab/plans/sahil/26-11-11-rk-daemon-autostart.md: "rk daemon autostart on|off|status" on Linux (systemd user unit). Read that plan (Goal, Decisions, brief A1) and the S1 findings fab/plans/sahil/26-11-11-rk-daemon-autostart-s1-findings.md (winning shape L7, already in this worktree via cherry-pick) first. Resolve A1's open decisions at intake (unit name; --now default) and record them. Do NOT enable autostart, enable lingering, or reboot on this machine — tests go behind seams. Once the intake is done, continue with /fab-fff. Another lane (A2, macOS) works the same verbs in parallel: keep the platform split clean (shared CLI surface vs. per-OS backend) so the two PRs merge without conflicts.

The operator dispatched this as one-shot. Lane rules (L1–L5) came with it: run tests only through `just`, never touch the live daemon or tmux server, and no recording since nothing changes in the UI.

**Sources (read these; they are binding):**
- `fab/plans/sahil/26-11-11-rk-daemon-autostart.md`: Goal, the "Decisions already taken" table (do not reopen), the four hazards, and brief A1.
- `fab/plans/sahil/26-11-11-rk-daemon-autostart-s1-findings.md`: the winning Linux shape **L7**, the environment-provenance findings, boot/lingering results, the hazard-4 findings, and "Inputs for A1 and A2 intake".

**Cross-lane agreement with A2 (macOS), made during intake by session messages.** The A2 session (`a2-macos-autostart`) proposed a file split and A1 acked it with changes (§ Platform split below). A2 writes the **shared commit** (shared CLI, interface, idempotent-start flag and memory skeleton) on origin branch `autostart-shared` and messages its sha. Both lanes carry that commit byte-identical, so whichever PR rebases second drops it as already applied. Any later change to a shared file is agreed by message first. If the shared commit has not arrived when apply starts, apply MAY write the shared files itself to the agreed contract below, but MUST then message A2 (`SendMessage` to the A2 session) with the sha so the two copies converge. It must not leave two diverging versions.

## Why

Nothing starts the HexoKit daemon after a reboot. `rk daemon` has only `start | stop | restart | status | run`, and `rk daemon start` is run by hand. Until someone runs it, every rk cron entry is silent: no operator ticks, no reminders, no respawns, and nothing reports it. The operator-pulse plan called this "the reboot hole". It gets worse once the operator lives inside the daemon: a daemon that isn't running then means no operator at all.

If we don't fix it, every reboot of an unattended Linux host silently disables the daemon, and with it the operator.

Why this approach (decided in the plan; not reopened): the OS's per-user service manager (a systemd **user** unit, no root) starts the daemon **once**. There is no `Restart=`, so this is not supervision, which the constitution forbids ("There is no supervisor loop"). The unit runs through the user's **login shell**, so the tmux server (and every agent born later) gets the user's PATH, credentials and so on. rk writes the unit itself through a new verb, rather than `brew services` (tied to the Homebrew install, with a bare environment).

## What Changes

### 1. New CLI: `rk daemon autostart on|off|status` (shared with A2)

```
rk daemon autostart on [--now] [--json]   # register (write unit, daemon-reload, enable); --now also starts it
rk daemon autostart status [--json]       # registered? enabled? boot or login? linger? last result? stale?
rk daemon autostart off [--json]          # disable + delete the unit; NEVER stops the running daemon
```

- File: `app/backend/cmd/rk/daemon_autostart.go` (shared): a cobra `autostart` parent with `on`, `off` and `status` children, wired into `daemonCmd` (`app/backend/cmd/rk/daemon.go`: one `AddCommand` line plus one line in the `Long` help's subcommand list: `autostart Start the daemon once at boot/login (on|off|status)`).
- A GOOS seam `autostartGOOS = runtime.GOOS` picks the backend through `autostart.For(autostartGOOS)`. An unregistered OS returns an error naming the platform, for example `rk daemon autostart: not supported on windows`.
- `--json` on all three verbs emits the standard `{ok,result}` envelope through `newSink(cmd).Envelope(...)` (`cmd/rk/output.go`). `on`/`off` emit `Result` and `status` emits `Status`. JSON field names are snake_case.
- Human output, `on`: `Autostart on: hexokit-daemon.service (starts at login; enable lingering to start at boot: loginctl enable-linger <user>)`. It says "already on" when nothing changed, and adds `started` with `--now`. `off`: `Autostart off: removed ~/.config/systemd/user/hexokit-daemon.service (the running daemon was left untouched)` or `Autostart already off`.
- Human output, `status`, one fact per line. An example (exact layout is the plan's call):
  ```
  Autostart:  on (login only — enable lingering to start at boot)
    Unit:     hexokit-daemon.service (~/.config/systemd/user/hexokit-daemon.service)
    Enabled:  yes
    Linger:   no — run: loginctl enable-linger sahil
    Last run: success (exit 0)
    Shell:    /usr/bin/zsh -l   (exports only in ~/.zshrc are NOT seen; put PATH/credentials in ~/.zprofile)
    rk:       /home/linuxbrew/.linuxbrew/bin/rk
  ```
  When the file differs from what `on` would write now, add `Stale: yes — re-run rk daemon autostart on`.

### 2. Shared package `app/backend/internal/daemon/autostart/` (contract agreed with A2)

`autostart.go` (shared, written once):
- `type OnOptions struct{ Now bool }`
- `type Backend interface { On(ctx, OnOptions) (Result, error); Off(ctx) (Result, error); Status(ctx) (Status, error) }`
- `type Result struct { Name, Path string; Changed, Started bool; Hints []string }`. `Changed` reports whether on/off altered anything, which is how idempotent re-runs say "already on/off".
- `type Status struct { Platform, Manager, Name, Path string; Registered, Enabled bool; StartsAt string /* "boot"|"login"|"" */; Linger *bool; LastExitCode *int; LastResult string; RKPath, Shell string; Stale bool; Hints []string }`, all with snake_case JSON tags. `Linger` is nil off Linux.
- Registry: `Register(goos string, f func() Backend)` and `For(goos string) (Backend, error)`.
- Helpers: `RKPath()` (see § 4), `StartScript(rkPath string, unsetEnv []string) string`, and `const ManagedMarker = "Managed by rk daemon autostart"`. There is **no shared login-shell var**: each backend owns its own login-shell lookup seam, so the shared file holds nothing OS-specific (A2's final shape, confirmed by message).
- The status **text renderer** lives in the shared `cmd/rk/daemon_autostart.go` and renders only from `Status` fields plus `Status.Hints`, so OS-specific advice (linger command, rc-file caveat) travels in `Hints` produced by the backend.
- `StartScript` output: `exec [env -u V1 -u V2 …] '<rkPath>' daemon start --if-not-running`. The `env -u …` prefix is omitted when `unsetEnv` is empty. The rk path is shell-quoted (single quotes, `internal/shellq` style). It contains no `||` and no grep on display text, and works in bash, zsh and fish.
- `autostart_test.go` (shared): tests for the registry and `StartScript`.
- No build tags. Each backend file self-registers in `init()`, so the shared code never names the other lane's symbols, each PR compiles alone, and both backends' tests run on Linux CI.

### 3. Shared: idempotent start, `rk daemon start --if-not-running`

S1 found that `rk daemon start` against a running daemon exits **1** (`Error: daemon already running`), so a plain `ExecStart` marks the unit `failed`. S1 also found that `rk daemon status` exits 0 either way, so it can't serve as a guard. L7 worked around this with `start || status | grep -q "^Daemon: *running"`, which ties the unit to display text. S1 itself proposed "an idempotent start flag" as the cleaner form, and A1 takes it:
- `app/backend/internal/daemon/daemon.go`: add the sentinel `var ErrAlreadyRunning = errors.New("daemon already running")`. `Start()` and `StartWithBinary()` return it in place of `fmt.Errorf("daemon already running")`, keeping the same message text so existing string matches keep working.
- `app/backend/cmd/rk/daemon_start.go`: a new flag `--if-not-running`. When `daemon.Start()` returns an error satisfying `errors.Is(err, daemon.ErrAlreadyRunning)`, print `run-kit daemon already running (rk-daemon/rk-daemon/serve)` and exit 0. Every other failure (port held by a foreground `rk serve`, tmux missing, rk unresolvable) still fails, so real failures stay visible in the unit's `Result`. This keeps L7's property (success when the daemon is already up, `failed` when rk is missing) without parsing text.
- Test in `daemon_start` tests: the already-running path exits 0 with the flag and 1 without it.

### 4. Linux backend: `app/backend/internal/daemon/autostart/systemd.go` (A1 only) + `systemd_test.go`

Self-registers: `func init() { Register("linux", newSystemd) }`.

**Unit name: `hexokit-daemon.service`** (open decision, resolved). Path: `<os.UserConfigDir()>/systemd/user/hexokit-daemon.service` (`~/.config/systemd/user/` by default, honoring `XDG_CONFIG_HOME`).

**Unit file (L7 shape, rendered by a pure function, byte-stable for tests):**
```ini
# Managed by rk daemon autostart — rewritten by `rk daemon autostart on`, removed by `off`. Do not edit.
[Unit]
Description=HexoKit daemon (started once at boot/login, not supervised)

[Service]
Type=oneshot
RemainAfterExit=yes
KillMode=process
TimeoutStartSec=90
ExecStart=<login shell> -lc "exec env -u INVOCATION_ID -u JOURNAL_STREAM -u MANAGERPID -u SYSTEMD_EXEC_PID -u MEMORY_PRESSURE_WATCH -u MEMORY_PRESSURE_WRITE '<rk path>' daemon start --if-not-running"

[Install]
WantedBy=default.target
```
- `Type=oneshot` + `RemainAfterExit=yes` + `KillMode=process` is the S1 winner L7. **No `Restart=`, ever** (plan decision: start, don't supervise). A test asserts the rendered unit contains no `Restart=` line.
- `TimeoutStartSec=90`: S1 found that a `Type=oneshot` unit has no start timeout by default, so a blocking login profile would hang it. With `KillMode=process`, a timeout kills only the shell, never an already-born tmux server.
- `env -u …` strips the systemd-injected variables (`INVOCATION_ID`, `JOURNAL_STREAM`, `MANAGERPID`, `SYSTEMD_EXEC_PID`, `MEMORY_PRESSURE_WATCH`, `MEMORY_PRESSURE_WRITE`). S1 saw them leak into the tmux server's global environment and so into every agent. The strip runs inside the login shell, after the profile, just before rk (shell-agnostic, since GNU/BSD `env -u` doesn't depend on the shell).
- **systemd escaping**: the `-lc` argument is double-quoted for systemd's ExecStart parser. The renderer escapes `\` → `\\` and `"` → `\"`, `%` → `%%` (specifier) and `$` → `$$` (env expansion) in the embedded script and the shell path. The shell path and rk path are additionally validated as absolute, clean paths (`filepath.IsAbs`, no control characters/newlines); anything else is refused with a clear error (Constitution I). Tests cover a path with a space and a path with `%`.

**Login shell** (S1: read it from the passwd database, not `$SHELL`). The Linux `LoginShell` runs `getent passwd <username>` via `exec.CommandContext` (5 s timeout) and takes field 7. Fallbacks: `$SHELL`, then `/bin/sh`. Validate that it is absolute and executable, and that its basename is not `nologin` or `false`; otherwise `on` fails with a clear error. It is resolved at `on` time and written as an absolute path. A later `chsh` shows up as `Stale` in `status`, and re-running `on` rewrites the unit.

**rk path** (`RKPath()`, shared): `selfpath.Stable()`, which maps a Homebrew Cellar path to the brew-prefix symlink that survives `brew upgrade` (`internal/selfpath`), the same rule as `StartWithBinary`'s callers. A non-brew install yields its resolved path unchanged. `status` adds a hint when the recorded rk path no longer exists.

**`on`** (idempotent):
1. Preflight: `exec.LookPath("systemctl")` and `/run/systemd/system` exists (sd_booted). Otherwise fail with `rk daemon autostart: systemd not found — on Linux, autostart needs a systemd user manager (systemctl --user)`.
2. If a file already exists at the unit path without `ManagedMarker`, refuse (`… exists and is not managed by rk; remove it or rename it first`).
3. Render the unit. If the on-disk bytes are identical, skip the write; otherwise write atomically (`internal/fsatomic.WriteFile`, 0644, `MkdirAll` the dir 0755).
4. `systemctl --user daemon-reload` (only when the file changed), then `systemctl --user enable hexokit-daemon.service`. `enable` is idempotent and **never `--now`**.
5. With `--now`: `systemctl --user restart hexokit-daemon.service`. `restart` re-runs the oneshot even when the unit is already `active (exited)` (a bare `start` on an active RemainAfterExit unit is a no-op). S1 verified that `restart` with the daemon up leaves one serve pane and `Result=success`, and with `--if-not-running` it is a no-op success. Report `Started: true`.
6. `Result.Changed` is true when the file was written or `enable` created the wants-symlink (check `is-enabled` before and after). Hints: the lingering hint when lingering is off, plus the rc-file caveat.

**`--now` default: off** (open decision, resolved): `on` registers only and starts nothing.

**`off`** (idempotent, **never stops the daemon**):
1. Unit file absent and `is-enabled` reports not-found: return `Changed:false` ("already off").
2. File present without `ManagedMarker`: refuse to delete.
3. `systemctl --user disable hexokit-daemon.service` (no `--now`, never `stop`), remove the file, then `systemctl --user daemon-reload`. A stale `active (exited)` in-memory unit after reload is harmless (S1: even an explicit `stop` under `KillMode=process` left tmux alive; `off` doesn't even stop).

**`status`**:
- `Registered`: the unit file exists and carries `ManagedMarker`.
- `Enabled`: `systemctl --user is-enabled hexokit-daemon.service` output equals `enabled`. A non-zero exit with `disabled`/`not-found` output is data, not an error.
- `LastResult`/`LastExitCode`: from `systemctl --user show hexokit-daemon.service -p Result -p ExecMainStatus -p ActiveState -p SubState`, parsed as `key=value` lines. `LastResult` is `Result` (`success`, `exit-code`, …), or empty when the unit never ran.
- `Linger`: `loginctl show-user <username> -p Linger --value` → `yes`/`no`. An error (not logged in, no logind) leaves `Linger` nil (unknown) and adds a hint, but does not fail the verb.
- `StartsAt`: `"boot"` when enabled and linger is yes; `"login"` when enabled and linger is no or unknown; `""` when not enabled. This is the fact A3's doctor row will read.
- `Stale`: on-disk bytes differ from a fresh render (shell or rk path changed).
- `Hints`: `loginctl enable-linger <user>` when linger is off; the interactive-rc caveat naming the shell's profile file (zsh → `~/.zprofile` vs `~/.zshrc`; bash → `~/.profile`/`~/.bash_profile` vs `~/.bashrc`; others → generic), including rc-only `TMUX_TMPDIR` (S1 hazard-2/3 note); `rk path missing` when the recorded rk path no longer exists.
- `status` never fails on a non-systemd Linux box. It returns an error naming the platform, the same as `on`.

**Seams (tests run no real systemctl/loginctl/getent and touch no real unit dir):** the backend struct holds
- `run func(ctx context.Context, name string, args ...string) (stdout []byte, err error)`, with the default wrapping `exec.CommandContext` and a per-call timeout (10 s for `systemctl` calls, 5 s for `loginctl`/`getent`; `restart` under `--now` gets 120 s because it blocks for the whole oneshot, which is itself bounded by `TimeoutStartSec=90`);
- `configDir func() (string, error)` (default `os.UserConfigDir`), `username func() (string, error)`, `lookPath`, `systemdBooted func() bool`, `rkPath`, `loginShell`.

`systemd_test.go` (temp dir, fake runner recording argv) covers:
- `on` writes the exact golden unit, runs `daemon-reload` then `enable` (never `start`/`--now`), and is a no-op on a re-run (`Changed:false`, no second write or reload).
- `on --now` adds `restart`.
- `on` refuses a foreign file.
- `off` runs `disable` + remove + `daemon-reload`, never `stop`; a second `off` is a no-op; `off` refuses a foreign file.
- `status` parsing: enabled/disabled/not-found; linger yes/no/error; Result success/exit-code/never-ran; `Stale` detection; `StartsAt` matrix.
- No systemd → error naming the platform.
- Escaping of `%`, `$`, `"`, spaces; refusal of relative/control-character paths.
- The rendered unit has no `Restart=`.

### 5. Hard limits for this lane

- **Never** run `on`, `enable`, `enable-linger` or a reboot on this machine. Never `rk serve`, `rk daemon start|restart`, or `RK_PORT` (L1). All verification goes through `just test-backend` with the seams above.
- No UI, no `rk doctor` row (that is A3), no `rk skill`/site docs (A4), no desktop-app switch (A2's decision).

## Affected Memory

- `run-kit/daemon-autostart`: (new) created by the shared commit with "## Linux (systemd)" and "## macOS (launchd)" sections. A1 fills **only** the Linux section at hydrate: unit name/path, the L7 shape and why, `--if-not-running`, login-shell/rk-path resolution, the env strip, on/off/status semantics, linger → boot/login, and the never-stops-the-daemon rule.
- `run-kit/daemon-lifecycle`: (modify) the shared commit adds a one-line pointer to daemon-autostart. A1's hydrate adds the `--if-not-running` flag / `ErrAlreadyRunning` sentinel to the start description if the shared commit did not.
- `run-kit/architecture/cli`: (modify) the daemon row gains the `autostart on|off|status` verb and `start --if-not-running`.

## Impact

- New files: `app/backend/internal/daemon/autostart/{autostart.go,autostart_test.go}` (shared), `app/backend/internal/daemon/autostart/{systemd.go,systemd_test.go}` (A1), `app/backend/cmd/rk/daemon_autostart.go` (+ test, shared).
- Modified: `app/backend/cmd/rk/daemon.go` (AddCommand plus a help line), `app/backend/cmd/rk/daemon_start.go` (`--if-not-running`), `app/backend/internal/daemon/daemon.go` (`ErrAlreadyRunning`).
- A2 adds `launchd.go`/`launchd_test.go` in the same package and touches no A1 file. A1 touches no A2 file.
- Behaviour for users who never run `autostart on`: unchanged (off by default).
- Toolkit standards: the new verbs get proper `Short`/`Long` help (help-dump), `--json` uses the shared envelope, and the change is checked against `shll standards` for the CLI surface.
- PR evidence: `No recording: CLI-only, nothing observable in the UI or shell`. Validated by unit tests behind seams, plus a manual render of the unit to stdout (no registration).

## Open Questions

- None blocking. Whether a unit started by a user manager can outlive that manager with lingering off (S1's unexplained surviving `rk daemon start` process) is noted for A5's real-machine test. A1 only reports "login only" and prints the linger command.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Systemd user unit, `Type=oneshot` + `RemainAfterExit=yes` + `KillMode=process`, no `Restart=`, `WantedBy=default.target`, ExecStart via the login shell `-lc` | Plan's "Decisions already taken" plus S1 verdict L7 (verbatim shape) | S:95 R:70 A:95 D:95 |
| 2 | Confident | Unit name `hexokit-daemon.service` | Open decision resolved at intake: the state/config homes and brew keg are `hexokit` and the binary name has drifted before (rk ↔ run-kit), so the product name is the stable handle `off` must find forever. `rk-daemon` is already the tmux socket and session name, so reusing it would be ambiguous. A2 suggested the same, and S1 found no technical constraint | S:70 R:55 A:70 D:65 |
| 3 | Confident | `--now` defaults to off: `on` registers only; `--now` runs `systemctl --user restart` | Open decision resolved: the brief says "Don't start it now unless `--now` is given", and it keeps `on` free of side effects on running processes, mirroring `off` never stopping. `restart` (not `start`) because a bare start on an active RemainAfterExit unit is a no-op; S1 verified that restart with the daemon up is a success with no duplicate | S:80 R:85 A:80 D:70 |
| 4 | Confident | Add `rk daemon start --if-not-running` (+ `daemon.ErrAlreadyRunning`) instead of L7's `\|\| status \| grep` | S1 flagged that the grep ties the unit to display text and suggested an idempotent start flag. It keeps L7's behaviour (success when up, failure when rk is missing). Agreed with A2 as part of the shared commit | S:70 R:75 A:75 D:60 |
| 5 | Confident | Platform split: shared `internal/daemon/autostart/autostart.go` + `cmd/rk/daemon_autostart.go` written once on `autostart-shared` by A2, per-OS `systemd.go`/`launchd.go` self-registering in `init()`, no build tags | Negotiated by message with the A2 session; it satisfies "merge without conflicts", and the plan scopes the work to `internal/daemon` + `cmd/rk/daemon*` | S:85 R:60 A:80 D:75 |
| 6 | Confident | Login shell from passwd via `getent passwd <user>` (fallback `$SHELL`, then `/bin/sh`), resolved at `on` time; reject nologin/false | S1: "Resolve the user's login shell from the passwd database (not `$SHELL`)". `getent` covers NSS/LDAP. Re-resolving at `on` plus `Stale` in status handles `chsh` | S:75 R:80 A:75 D:65 |
| 7 | Confident | rk path = `selfpath.Stable()` (brew-prefix symlink, not the Cellar path) | Brief: "Resolve the rk path so it survives brew upgrade (the Homebrew opt symlink, not the Cellar path)". `selfpath.Stable` is the codebase's existing resolver for processes that outlive the binary version | S:80 R:85 A:85 D:75 |
| 8 | Confident | Strip systemd-injected vars with `env -u …` inside the login shell before rk | S1 § Environment item 3 recommends it (untested); harmless if a variable is absent; shell-agnostic | S:60 R:85 A:65 D:65 |
| 9 | Confident | `TimeoutStartSec=90` | S1 "Not covered": oneshot has no start timeout, so a blocking profile would hang the unit. Under `KillMode=process` the timeout kills only the shell. The value is a judgment call, easy to change | S:55 R:90 A:60 D:55 |
| 10 | Confident | `off` = `disable` (no `--now`) + delete the file + `daemon-reload`; never `stop`; refuse to delete a file lacking `ManagedMarker` | Brief: "off must never stop the running daemon". The marker guard prevents deleting a user's own unit with the same name | S:80 R:70 A:80 D:75 |
| 11 | Confident | `--json` on all three verbs (not only `status`) with the `{ok,result}` envelope | Brief names `--json` for status; A2 follows A1's flags, and scripting `on`/`off` (A3/A5) benefits. The shared envelope makes it cheap. Agreed with A2 | S:55 R:85 A:70 D:60 |
| 12 | Confident | Linger read via `loginctl show-user <user> -p Linger --value`; an error means unknown (nil), not a failure | S1 named this exact call. A user without a logind session must still get a status | S:75 R:85 A:75 D:70 |
| 13 | Confident | `StartsAt` = boot (enabled ∧ linger) / login (enabled ∧ ¬linger) / "" (not enabled) | Plan's Linux-timing decision plus S1 hazard-3 results; the field feeds A3's doctor row wording | S:80 R:85 A:80 D:80 |
| 14 | Certain | No recording; CLI-only with unit tests behind seams; never register/enable/linger/reboot on this machine | Lane brief L1/L2 plus plan rule 3; Constitution § PR Evidence exempts CLI-only changes with a `No recording:` line | S:95 R:90 A:95 D:95 |
| 15 | Confident | systemd-quote the `-lc` argument (escape `\ " % $`) and validate both paths as absolute with no control characters | Constitution I (no injection) plus systemd ExecStart's specifier/env expansion rules; a space in `$HOME` must still work | S:60 R:80 A:70 D:60 |

15 assumptions (2 certain, 13 confident, 0 tentative, 0 unresolved).
