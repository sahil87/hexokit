# HexoKit daemon autostart — S1 spike findings

> Findings of step **S1** of `fab/plans/sahil/26-11-11-rk-daemon-autostart.md`, run 2026-11-11 on
> `rk v3.22.9` (static binary). Decisions already taken in the plan are not restated here. Linux only:
> the macOS half is a documented candidate and was **not tested** (§ macOS).

## How it was run

- Throwaway container `ubuntu:24.04` with systemd as PID 1 (`sudo docker run --privileged --cgroupns=private`, tmpfs on `/run` and `/tmp`), a test user `tester` (uid 1001, login shell `bash`), `rk` copied in. Nothing was registered on the host's systemd, host lingering stayed `Linger=no`, and the host's `rk-daemon` tmux server was never touched. Container and image were deleted afterwards.
- `~/.profile` (sourced via `~/.bash_profile`) exports `PATH`, `SSH_AUTH_SOCK`, `ANTHROPIC_API_KEY` (fake) and `S1_PROFILE_MARK`. `~/.bashrc` exports `S1_BASHRC_MARK` after the usual non-interactive guard.
- **Limits.** A container restart stands in for a reboot (no KVM on the host, so no VM): it re-runs systemd's boot and the lingering path, but does not exercise the kernel/hardware boot. The container's tmux is 3.4, the host's is 3.8. `rk` was not run against a real SSH login, so `SSH_AUTH_SOCK` was a profile-set stand-in.

## Verdict

**Winning Linux shape: L7** — `Type=oneshot` + `RemainAfterExit=yes` + `KillMode=process`, with a start command that also reads as success when the daemon is already running.

```ini
[Unit]
Description=HexoKit daemon (started once at boot/login, not supervised)

[Service]
Type=oneshot
RemainAfterExit=yes
KillMode=process
ExecStart=/bin/bash -lc 'rk daemon start || rk daemon status | grep -q "^Daemon: *running"'

[Install]
WantedBy=default.target
```

As tested, `rk` was resolved by the login shell's `PATH` (`/opt/homebrew-sim/bin`). A1 should substitute the absolute path and the user's real login shell (`$SHELL` is **unset** inside a user unit, systemd does not provide it).

## Results matrix

`ExecStart` is `/bin/bash -lc '<…>'` in every row; none has `Restart=`.

| # | Shape | H1 tmux alive after start | H1 survives `stop` | H1 survives `disable` | H4 start while daemon already up | Verdict |
|---|---|---|---|---|---|---|
| L1 | `oneshot` + `RemainAfterExit=yes` | yes | **no** (killed) | **no** (already dead) | unit already `active`: no-op; a real second `ExecStart` would exit 1 (same command as L3, not run separately) | rejected |
| L2 | `forking` | yes | **no** | **no** | as L1 | rejected |
| L3 | L1 + `KillMode=process` | yes | **yes** | **yes** | **fails**: `rk daemon start` exits 1 `Error: daemon already running`, unit `failed` | needs a start guard |
| L4 | L2 + `KillMode=process` | yes | **no** (systemd guesses the tmux server as the main PID and kills it) | no | as L1 | rejected |
| L5 | L3 + `rk daemon status >/dev/null || rk daemon start` | **no, daemon never started** | n/a | n/a | n/a | rejected: `rk daemon status` exits 0 even when the daemon is stopped |
| L6 | L3 with `ExecStart=-…` (ignore any failure) | yes | yes | yes | success | rejected: also reads as success when `rk` is missing, hiding real failures |
| **L7** | L3 + `start \|\| status \| grep -q "^Daemon: *running"` | **yes** | **yes** | **yes** | **success** | **winner** |

L7 checks, all on one run:
- Down → `systemctl --user restart` starts it: `Result=success`, `rk-daemon`, `rk-code-server`, `_rk-ctl` sessions present.
- Already up → `restart` leaves exactly one `rk-daemon:serve` pane, `Result=success`.
- `rk` not found → unit `failed` (the real failure stays visible).
- `systemctl --user daemon-reload` with the daemon up: tmux untouched, no second daemon (run on L1–L4, which share L7's start behaviour; not re-run on L7).
- With `KillMode=process`, the journal logs `Unit process … (tmux: server) remains running after unit stopped.` on stop. That line is expected, not an error.

## Environment provenance (hazard 2)

`tmux -L rk-daemon show-environment -g`, interactive manual start versus unit-started (L3 and L7 identical to each other apart from `INVOCATION_ID`, `JOURNAL_STREAM`, `MEMORY_PRESSURE_WATCH`, `SYSTEMD_EXEC_PID`):

| Variable | Manual (interactive login shell) | Unit (`bash -lc`) |
|---|---|---|
| `PATH` with the Homebrew prefix (set in `.profile`) | yes | yes |
| `SSH_AUTH_SOCK` (set in `.profile`) | yes | yes |
| `ANTHROPIC_API_KEY` (set in `.profile`) | yes | yes |
| `S1_PROFILE_MARK` (`.profile`) | yes | yes |
| `S1_BASHRC_MARK` (`.bashrc`, interactive only) | **yes** | **no** |
| `LANG` / `LC_CTYPE` | `LC_CTYPE=C.UTF-8` (set by rk's `EnsureUTF8Locale`) | `LANG=C.UTF-8` (from the unit manager) |
| `SHELL`, `USER`, `LOGNAME` | absent here (docker exec) | set by systemd |
| `SHLVL` | 1 | 0 |

What this means for A1:
1. **A non-interactive login shell misses anything set only in the interactive rc file** (`.bashrc` after its guard; for zsh, `.zshrc`). A user who keeps `PATH` or credentials only there gets a daemon whose agents cannot find them. `autostart status` and the docs must say so, and the fix is to move the exports to `.profile`/`.zprofile`.
2. **`SSH_AUTH_SOCK` is only inherited if the profile sets it.** An agent socket created per login by `sshd` does not exist at boot, so a boot-started daemon cannot have it. This is inherent, not a unit-shape problem.
3. **systemd leaks its own variables into the tmux server's global environment**, and so into every agent: `INVOCATION_ID`, `JOURNAL_STREAM`, `MANAGERPID`, `SYSTEMD_EXEC_PID`, `MEMORY_PRESSURE_WATCH` and `MEMORY_PRESSURE_WRITE`. `MEMORY_PRESSURE_WATCH` points at the unit's cgroup. They are harmless in this run, but A1 may want to strip them (`env -u …` ahead of `rk daemon start` inside the shell command). Not tested.
4. The unit environment has no `DISPLAY`, `WAYLAND_DISPLAY` or desktop session variables; not tested beyond noting their absence.

## Boot and lingering (hazard 3, Linux)

Container restart used as a reboot stand-in, L3 enabled, no login session at any point:

| Case | Result |
|---|---|
| Lingering **on** | `user@1001` active with 0 login sessions; unit `active (exited)`, `Result=success`; `rk daemon status` reports running. The tmux socket is `/tmp/tmux-1001/rk-daemon`, the same path an interactive shell of that user resolves (`TMUX_TMPDIR` unset in both). `HOME=/home/tester` and `XDG_RUNTIME_DIR=/run/user/1001` are set in the tmux server's environment. |
| Lingering **off** | No user manager and no tmux socket after boot. Starting `user@1001` (what `pam_systemd` does on first login) starts the unit and the daemon. |
| Lingering **off**, last logout | Stopping `user@1001` **kills the daemon even with `KillMode=process`** (the user manager tears down its slice). So with lingering off the daemon only lives for as long as some session of that user exists. `autostart status` must say "login only" and print `loginctl enable-linger <user>`; the plan's wording is confirmed. |

## Hazard 4 (manager restart, second start)

- `rk daemon start` against a running daemon prints `Error: daemon already running` and exits **1**, so a plain `ExecStart` makes the unit `failed` on every login after the first. L7's `|| rk daemon status | grep -q "^Daemon: *running"` turns that into success while keeping real failures visible.
- `rk daemon status` exits **0** whether the daemon is running or not, so it cannot be used as a guard by exit code; its text (`Daemon:    running`) must be matched. Worth keeping in mind for A1's `status` verb and for any `rk` change that gives `status` a meaningful exit code.
- `systemctl --user daemon-reload` and `restart` of the unit never produced a second `rk-daemon` session or a second `serve` pane.

## Cron entries after a reboot

An entry (`--role operator --if-absent respawn --respawn rk --respawn operator --respawn -L --respawn '{server}'`) was added for a tmux server `opsrv`, then the container restarted so `opsrv` no longer existed while the daemon was up:

- The entry file `~/.local/state/hexokit/cron/opsrv.yaml` survived and `rk cron list -L opsrv` still lists the entry with `LAST-FIRED -`.
- `rk cron tick`: `tick: 0 servers swept, 0 fires, 1 diagnostics`, exit 0, repeated over more than a minute. **Nothing fired, no respawn was attempted, and nothing in the daemon's output named the problem.** The sweep covers live servers only, so `--if-absent respawn` only helps when the target window or pane vanishes inside a live server, not when the whole server is gone. This is the observation the plan asked for; fixing it is out of scope.
- The text of the one diagnostic was not captured (`tick` prints only the count).

## macOS (candidate, **untested**)

No macOS host was reachable. Candidate for A2, to be verified there:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>REPLACE-WITH-LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>rk daemon start || rk daemon status | grep -q "^Daemon: *running"</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
</dict>
</plist>
```

No `KeepAlive`. A2 must check: (1) with and without `AbandonProcessGroup` does the tmux server survive the job exiting; (2) does `launchctl bootout gui/<uid>/<label>` leave it running; (3) the environment diff of § Environment provenance, using `zsh -lc` (reads `.zprofile`, not `.zshrc`) and Homebrew's `PATH`, which on Apple silicon is set by `brew shellenv` in `.zprofile`; (4) the tmux socket path under macOS's per-user `TMPDIR`, since a LaunchAgent and a Terminal shell may see different `TMPDIR`; (5) a second login not starting a second daemon.

## Inputs for A1 and A2 intake (decisions stay theirs)

| Open decision | Input from S1 |
|---|---|
| Unit name and launchd label | No technical constraint found; any valid unit name works. |
| `on` also starting the daemon now | The unit is safe to start immediately: with L7, starting while the daemon is up is a no-op success. `--now` can therefore be cheap and idempotent. |
| `off` must not stop the daemon | Confirmed achievable: with `KillMode=process`, `stop` and `disable` left tmux running. |
| `status` content | Report lingering (`loginctl show-user <user> -p Linger`), the unit's `Result`, and the interactive-rc caveat. |
| Environment | Resolve the user's login shell from the passwd database (not `$SHELL`), use the absolute `rk` path, and consider stripping the systemd-injected variables. |

## Not covered

- A real reboot of real hardware or a VM.
- Real `sshd` agent forwarding, `zsh`, `fish`, and non-systemd init systems.
- Stripping systemd-injected variables, and the unit's behaviour under `systemctl --user import-environment`.
- macOS entirely.
