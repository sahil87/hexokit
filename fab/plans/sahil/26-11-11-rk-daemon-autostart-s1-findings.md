# HexoKit daemon autostart — S1 spike findings

> Findings of step **S1** of `fab/plans/sahil/26-11-11-rk-daemon-autostart.md`, run 2026-11-11 on
> `rk v3.22.9` (static binary). Decisions already taken in the plan are not restated here. Linux only:
> the macOS half is a documented candidate and was **not tested** (§ macOS).

## How it was run

- Throwaway container `ubuntu:24.04` with systemd as PID 1 (`sudo docker run --privileged --cgroupns=private`, tmpfs on `/run` and `/tmp`), a test user `tester` (uid 1001, login shell `bash`), `rk` copied in. Nothing was registered on the host's systemd, host lingering stayed `Linger=no`, and the host's `rk-daemon` tmux server was never touched. Container and images were deleted afterwards. The container was built twice: the first run covered L1–L6, hazard 3 and the cron entry; a second, identical rebuild re-ran the winner L7 (`stop`/`disable`, environment) after review.
- **Procedure per candidate** (`cand.sh`, as the test user): write `~/.config/systemd/user/s1-<n>.service`; `tmux -L rk-daemon kill-server`; `daemon-reload`; `start` (wait 4 s) and check the tmux server and the unit's `Result`; dump `tmux -L rk-daemon show-environment -g`; `start` again; `daemon-reload`; `stop`; `enable` then `disable`, checking tmux after each. Candidates L5–L7 were exercised by `restart` with the daemon down, `restart` with it up, and `rk` made unresolvable. L7 was additionally run through `start`, `stop`, `enable`+`disable` and a `stop`→`start` against the live daemon (appendix). Raw output excerpts are in the appendix; the lab itself is gone.
- **Pruning.** L1 and L2 were rejected on hazard 1 (the daemon dies on `stop`), so no hazard-2 comparison or hazard-3 run was made on them. `cand.sh` dumped the tmux environment for L1–L4, but it was kept and compared for L1 and L3 (and L7 on the re-run) only; hazard 3 ran on L3 only. L4 was rejected on the same grounds.
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

L1–L4 used the absolute `/opt/homebrew-sim/bin/rk`; L5–L7 resolved `rk` through the login shell's `PATH` (`/opt/homebrew-sim/bin`). A1 should substitute the absolute path and the user's real login shell (do not rely on `$SHELL` when generating the unit or at `autostart on` time; the user manager sets `SHELL` in the started process, but A1 must look the shell up itself, and systemd's `%s` specifier expands to the user's shell).

## Results matrix

`ExecStart` is `/bin/bash -lc '<…>'` in every row; none has `Restart=`.

| # | Shape | H1 tmux alive after start | H1 survives `stop` | H1 survives `disable` | H4 start while daemon already up | Verdict |
|---|---|---|---|---|---|---|
| L1 | `oneshot` + `RemainAfterExit=yes` | yes | **no** (killed) | **no** (already dead) | unit already `active`: no-op; a real second `ExecStart` would exit 1 (same command as L3, not run separately) | rejected |
| L2 | `forking` | yes | **no** | **no** | as L1 | rejected |
| L3 | L1 + `KillMode=process` | yes | **yes** | **yes** | **fails**: `rk daemon start` exits 1 `Error: daemon already running`, unit `failed` | needs a start guard |
| L4 | L2 + `KillMode=process` | yes | **no** (observed `tmux DEAD`; likely cause: `Type=forking` without `PIDFile=` makes systemd guess the main PID, probably the tmux server — not confirmed) | no | as L1 | rejected |
| L5 | L3 + `rk daemon status >/dev/null || rk daemon start` | **no, daemon never started** | n/a | n/a | n/a | rejected: `rk daemon status` exits 0 even when the daemon is stopped |
| L6 | L3 with `ExecStart=-…` (ignore any failure) | yes | not run (expected yes: same `KillMode=process` as L3) | not run (expected yes) | success | rejected: also reads as success when `rk` is missing, hiding real failures |
| **L7** | L3 + `start \|\| status \| grep -q "^Daemon: *running"` | **yes** | **yes** (same tmux server PID before and after `stop`) | **yes** | **success** (`stop`→`start` against the live daemon, `Result=success`, one `serve` pane) | **winner** |

L7 checks (the first three on the `restart` run, `stop`/`disable` on the re-run described above):
- Down → `systemctl --user restart` starts it: `Result=success`, `rk-daemon`, `rk-code-server`, `_rk-ctl` sessions present.
- Already up → `restart`: `Result=success`; on the re-run, `stop`→`start` against the live daemon left one `rk-daemon:serve` pane (pane listing). The `serve procs: 2` counts in the appendix come from `pgrep -fc 'rk serve'`, which also matches the tmux server's own argv, so 2 means one server plus one serve process.
- `rk` not found → unit `failed` (the real failure stays visible).
- `systemctl --user daemon-reload` with the daemon up: tmux untouched, no second daemon (run on L1–L4, which share L7's start behaviour; not re-run on L7).
- H2/H3 per candidate: environment compared for L1, L3, L7 only; H3 on L3 only; L2/L4 rejected on H1; L5/L6 not run beyond H1/H4.
- With `KillMode=process`, the journal logs `Unit process … (tmux: server) remains running after unit stopped.` on stop. That line is expected, not an error.

## Environment provenance (hazard 2)

`tmux -L rk-daemon show-environment -g`, interactive manual start versus unit-started (L1, L3 and L7 identical to each other apart from `INVOCATION_ID`, `JOURNAL_STREAM`, `MEMORY_PRESSURE_WATCH`, `SYSTEMD_EXEC_PID`, and `SHLVL` on L7 — its compound `A || B` command keeps the shell from exec'ing):

| Variable | Manual (interactive login shell) | Unit (`bash -lc`) |
|---|---|---|
| `PATH` with the Homebrew prefix (set in `.profile`) | yes | yes |
| `SSH_AUTH_SOCK` (set in `.profile`) | yes | yes |
| `ANTHROPIC_API_KEY` (set in `.profile`) | yes | yes |
| `S1_PROFILE_MARK` (`.profile`) | yes | yes |
| `S1_BASHRC_MARK` (`.bashrc`, interactive only) | **yes** | **no** |
| `LANG` / `LC_CTYPE` | `LC_CTYPE=C.UTF-8` (set by rk's `EnsureUTF8Locale`) | `LANG=C.UTF-8` (from the unit manager) |
| `SHELL`, `USER`, `LOGNAME` | absent here (docker exec) | set by systemd |
| `SHLVL` | 1 | 0 (L1, L3), 1 (L7) |
| Base `PATH` | no `/usr/games:/usr/local/games:/snap/bin` | adds those from the user manager |
| `LS_COLORS`, `LESSOPEN`, `LESSCLOSE` (skel rc) | yes | **no** (more rc-only state) |

The manual baseline is `docker exec -u tester bash -lic`, not a PAM login, and carries container artefacts (`DEBIAN_FRONTEND`, `container`, `HOSTNAME`) and harness-injected `HOME`/`XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`. Read the table as a login-shell versus non-interactive-login-shell comparison.

What this means for A1:
1. **A non-interactive login shell misses anything set only in the interactive rc file** (`.bashrc` after its guard; for zsh, `.zshrc`). A user who keeps `PATH` or credentials only there gets a daemon whose agents cannot find them. `autostart status` and the docs must say so, and the fix is to move the exports to `.profile`/`.zprofile`.
2. **`SSH_AUTH_SOCK` is only inherited if the profile sets it.** An agent socket created per login by `sshd` does not exist at boot, so a boot-started daemon cannot have it. This is inherent, not a unit-shape problem.
   Interaction with hazard 3: a user who exports `TMUX_TMPDIR` only in `.bashrc`/`.zshrc` gets a unit-started daemon on `/tmp/tmux-UID/rk-daemon` while an interactive `rk` and the UI look under `$TMUX_TMPDIR`, so the daemon appears absent and the socket path splits. Not reproduced; follows from items 1 and the Lingering-on row below.
3. **systemd leaks its own variables into the tmux server's global environment**, and so into every agent: `INVOCATION_ID`, `JOURNAL_STREAM`, `MANAGERPID`, `SYSTEMD_EXEC_PID`, `MEMORY_PRESSURE_WATCH` and `MEMORY_PRESSURE_WRITE`. `MEMORY_PRESSURE_WATCH` points at the unit's cgroup. They are harmless in this run, but A1 may want to strip them (`env -u …` ahead of `rk daemon start` inside the shell command). Not tested.
4. The unit environment has no `DISPLAY`, `WAYLAND_DISPLAY` or desktop session variables; not tested beyond noting their absence.

## Boot and lingering (hazard 3, Linux)

Container restart used as a reboot stand-in, L3 enabled, no login session at any point:

| Case | Result |
|---|---|
| Lingering **on** | `user@1001` active with 0 login sessions; unit `active (exited)`, `Result=success`; `rk daemon status` reports running. The tmux socket is `/tmp/tmux-1001/rk-daemon`, the same path an interactive shell of that user resolves (`TMUX_TMPDIR` unset in both; see the `TMUX_TMPDIR` caveat above). `HOME=/home/tester` and `XDG_RUNTIME_DIR=/run/user/1001` are set in the tmux server's environment. |
| Lingering **off** | No user manager and no tmux socket after boot. Starting `user@1001` (what `pam_systemd` does on first login) starts the unit and the daemon. |
| Lingering **off**, last logout | Stopping `user@1001` **kills the daemon even with `KillMode=process`** (the user manager tears down its slice). Two anomalies in that run are unexplained: `user@1001` ended `failed` (not `inactive`, possibly a container artefact), and a process `/opt/homebrew-sim/bin/rk daemon start` survived the teardown. A1 should check whether a start can outlive its user manager. So with lingering off the daemon only lives for as long as some session of that user exists. `autostart status` must say "login only" and print `loginctl enable-linger <user>`; the plan's wording is confirmed. |

## Hazard 4 (manager restart, second start)

- `rk daemon start` against a running daemon prints `Error: daemon already running` and exits **1**, so a plain `ExecStart` makes the unit `failed` whenever it runs against a live daemon: after a manual `rk daemon start`, with `autostart on --now`, or on an explicit `stop`→`start`/`restart` (observed). A bare `start` on an already-active `RemainAfterExit` unit never re-runs `ExecStart`. A real second login through PAM was **not** exercised. L7's `|| rk daemon status | grep -q "^Daemon: *running"` turns that into success while keeping real failures visible.
- `rk daemon status` exits **0** whether the daemon is running or not, so it cannot be used as a guard by exit code; its text (`Daemon:    running`) is what L7 matches, which ties the unit to display text. `rk daemon status --json` exists (`{ok,result}` envelope) and A1, which generates the unit in Go, could use it, or add a status exit code or an idempotent start flag. Worth keeping in mind for A1's `status` verb and for any `rk` change that gives `status` a meaningful exit code.
- `systemctl --user daemon-reload` and `restart` of the unit never produced a second `rk-daemon` session or a second `serve` pane.

## Cron entries after a reboot

An entry (`--role operator --if-absent respawn --respawn rk --respawn operator --respawn -L --respawn '{server}'`) was added for a tmux server `opsrv`, then the container restarted so `opsrv` no longer existed while the daemon was up:

- The entry file `~/.local/state/hexokit/cron/opsrv.yaml` survived and `rk cron list -L opsrv` still lists the entry with `LAST-FIRED -`.
- `rk cron tick`: `tick: 0 servers swept, 0 fires, 1 diagnostics`, exit 0, run three times. **Nothing fired and no respawn was attempted; the `tick` CLI printed only a diagnostic count.** The in-container daemon log held no cron lines and the diagnostic's text was not captured. By the source (`app/backend/internal/cron/tick.go`), an entry file whose server is not live is skipped with reason `server-not-live`. The sweep covers live servers only, so `--if-absent respawn` only helps when the target window or pane vanishes inside a live server, not when the whole server is gone. This is the observation the plan asked for; fixing it is out of scope.

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
| `off` must not stop the daemon | `stop` under `KillMode=process` left tmux running (confirmed). `off`'s full sequence — disable, delete the unit file, `daemon-reload` while the unit is active — was **not** run (`disable` always followed a `stop`); A1 should verify it. |
| `status` content | Report lingering (`loginctl show-user <user> -p Linger`), the unit's `Result`, and the interactive-rc caveat, including rc-only `TMUX_TMPDIR`. |
| Environment | Resolve the user's login shell from the passwd database (not `$SHELL`), use the absolute `rk` path, and consider stripping the systemd-injected variables. |

## Not covered

- `off`'s delete-unit-file plus `daemon-reload` on an active unit, `TimeoutStartSec=` (a blocking login profile would hang a `Type=oneshot` unit, which has no start timeout by default), and `MANAGERPID` among the injected variables.
- A real reboot of real hardware or a VM, and a real PAM re-login (hazard 4's "re-login").
- Real `sshd` agent forwarding, `zsh`, `fish`, and non-systemd init systems.
- Stripping systemd-injected variables, and the unit's behaviour under `systemctl --user import-environment`.
- macOS entirely.

## Appendix — raw output excerpts

Captured in the throwaway lab; shown unedited apart from trimming.

### Candidates L1–L4 (`cand.sh`)

```
=== L1 ===
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -lc '/opt/homebrew-sim/bin/rk daemon start'
start rc=0
after start: tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); unit: Result=success ExecMainStatus=0 ActiveState=active SubState=exited 
-- start again while running
rc=0 Result=success ActiveState=active SubState=exited 
tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); serve panes: 2
-- daemon-reload
tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); serve procs: 2
-- stop
after stop: tmux DEAD
-- enable then disable
Created symlink /home/tester/.config/systemd/user/default.target.wants/s1-L1.service → /home/tester/.config/systemd/user/s1-L1.service.
after enable: tmux DEAD
Removed "/home/tester/.config/systemd/user/default.target.wants/s1-L1.service".
after disable: tmux DEAD
=== L2 ===
Type=forking
ExecStart=/bin/bash -lc '/opt/homebrew-sim/bin/rk daemon start'
start rc=0
after start: tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); unit: Result=success ExecMainStatus=0 ActiveState=active SubState=running 
-- start again while running
rc=0 Result=success ActiveState=active SubState=running 
tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); serve panes: 2
-- daemon-reload
tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); serve procs: 2
-- stop
after stop: tmux DEAD
-- enable then disable
Created symlink /home/tester/.config/systemd/user/default.target.wants/s1-L2.service → /home/tester/.config/systemd/user/s1-L2.service.
after enable: tmux DEAD
Removed "/home/tester/.config/systemd/user/default.target.wants/s1-L2.service".
after disable: tmux DEAD
=== L3 ===
Type=oneshot
RemainAfterExit=yes
KillMode=process
ExecStart=/bin/bash -lc '/opt/homebrew-sim/bin/rk daemon start'
start rc=0
after start: tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); unit: Result=success ExecMainStatus=0 ActiveState=active SubState=exited 
-- start again while running
rc=0 Result=success ActiveState=active SubState=exited 
tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); serve panes: 2
-- daemon-reload
tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); serve procs: 2
-- stop
after stop: tmux ALIVE (_rk-ctl rk-code-server rk-daemon )
-- enable then disable
Created symlink /home/tester/.config/systemd/user/default.target.wants/s1-L3.service → /home/tester/.config/systemd/user/s1-L3.service.
after enable: tmux ALIVE (_rk-ctl rk-code-server rk-daemon )
Removed "/home/tester/.config/systemd/user/default.target.wants/s1-L3.service".
after disable: tmux ALIVE (_rk-ctl rk-code-server rk-daemon )
=== L4 ===
Type=forking
KillMode=process
ExecStart=/bin/bash -lc '/opt/homebrew-sim/bin/rk daemon start'
start rc=0
after start: tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); unit: Result=success ExecMainStatus=0 ActiveState=active SubState=running 
-- start again while running
rc=0 Result=success ActiveState=active SubState=running 
tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); serve panes: 2
-- daemon-reload
tmux ALIVE (_rk-ctl rk-code-server rk-daemon ); serve procs: 2
-- stop
after stop: tmux DEAD
-- enable then disable
Created symlink /home/tester/.config/systemd/user/default.target.wants/s1-L4.service → /home/tester/.config/systemd/user/s1-L4.service.
after enable: tmux DEAD
Removed "/home/tester/.config/systemd/user/default.target.wants/s1-L4.service".
after disable: tmux DEAD
```

### Unit run while the daemon is already up (L3)

```
##### H4b: unit run while daemon already up
direct: 
Error: daemon already running
rc=1
tmux after stop: _rk-ctl: 1 windows (created Wed Nov 11 07:52:37 2026)
Job for s1-L3.service failed because the control process exited with error code.
See "systemctl --user status s1-L3.service" and "journalctl --user -xeu s1-L3.service" for details.
start rc=1
unit: Result=exit-code ExecMainStatus=1 ActiveState=failed SubState=failed 
Nov 11 07:54:09 eaa3d60778e6 systemd[86]: Starting s1-L3.service - S1 candidate L3...
Nov 11 07:54:09 eaa3d60778e6 bash[339]: Error: daemon already running
Nov 11 07:54:09 eaa3d60778e6 systemd[86]: s1-L3.service: Main process exited, code=exited, status=1/FAILURE
Nov 11 07:54:09 eaa3d60778e6 systemd[86]: s1-L3.service: Failed with result 'exit-code'.
Nov 11 07:54:09 eaa3d60778e6 systemd[86]: s1-L3.service: Unit process 112 (tmux: server) remains running after unit stopped.
Nov 11 07:54:09 eaa3d60778e6 systemd[86]: Failed to start s1-L3.service - S1 candidate L3.
##### serve pane count after repeated starts (no duplicates?)
_rk-ctl:bash 148
rk-code-server:code-server 135
rk-daemon:serve 114
2
```

### L5 (status-based guard; never started the daemon)

```
##### status exit codes
running: rc=0
stopped: rc=0
##### L5 = L3 + guarded ExecStart (start only when not running)
-- case A: daemon down
rc=0 Result=success ActiveState=active SubState=exited 
tmux: no server running on /tmp/tmux-1001/rk-daemon 
-- case B: daemon already up, restart unit
rc=0 Result=success ActiveState=active SubState=exited 
serve procs: 1
-- case C: stop/disable leaves daemon
tmux: no server running on /tmp/tmux-1001/rk-daemon 
Nov 11 07:54:23 eaa3d60778e6 systemd[86]: Stopped s1-L5.service - S1 candidate L5.
Nov 11 07:54:23 eaa3d60778e6 systemd[86]: Stopping s1-L5.service - S1 candidate L5...
Nov 11 07:54:23 eaa3d60778e6 systemd[86]: Starting s1-L5.service - S1 candidate L5...
Nov 11 07:54:23 eaa3d60778e6 systemd[86]: Finished s1-L5.service - S1 candidate L5.
Nov 11 07:54:23 eaa3d60778e6 systemd[86]: Stopped s1-L5.service - S1 candidate L5.
```

### L6 and L7 (down / up / `rk` missing)

```
=== L6 ===
ExecStart=-/bin/bash -lc 'rk daemon start'
A (down): rc=0 Result=success ActiveState=active SubState=exited 
   tmux: _rk-ctl rk-code-server rk-daemon 
B (up):   rc=0 Result=success ActiveState=active SubState=exited 
   serve procs: 2
C (rk missing -> real failure should be visible):
   rc=0 Result=success ActiveState=active SubState=exited 
=== L7 ===
ExecStart=/bin/bash -lc 'rk daemon start || rk daemon status | grep -q "^Daemon: *running"'
A (down): rc=0 Result=success ActiveState=active SubState=exited 
   tmux: _rk-ctl rk-code-server rk-daemon 
B (up):   rc=0 Result=success ActiveState=active SubState=exited 
   serve procs: 2
C (rk missing -> real failure should be visible):
See "systemctl --user status s1-L7.service" and "journalctl --user -xeu s1-L7.service" for details.
   rc=0 Result=exit-code ActiveState=failed SubState=failed 
```

### L7 `stop` / `disable` / `stop`→`start` (re-run)

```
=== L7 stop/disable ===
start: Result=success ActiveState=active SubState=exited  tmux ALIVE
serve panes: 1
server pid before: 149
after stop: tmux ALIVE pid 149
Created symlink /home/tester/.config/systemd/user/default.target.wants/s1-L7.service → /home/tester/.config/systemd/user/s1-L7.service.
Removed "/home/tester/.config/systemd/user/default.target.wants/s1-L7.service".
after enable+disable: tmux ALIVE
--- explicit stop->start while up (the re-run-against-live-daemon case)
rc=0 Result=success ActiveState=active 
serve panes: 1
```

### Boot and lingering (L3)

```
##### H3a: linger ON, L3 enabled, container restart (reboot stand-in), NO login
Linger=yes
login sessions: 0
user@1001: active
unit: Result=success ActiveState=active SubState=exited 
_rk-ctl: 1 windows (created Wed Nov 11 07:51:24 2026)
rk-code-server: 1 windows (created Wed Nov 11 07:51:24 2026)
rk-daemon: 1 windows (created Wed Nov 11 07:51:24 2026) (attached)
total 0
srwxrwx--- 1 tester tester 0 Nov 11 07:51 rk-daemon
TMUX_TMPDIR=[]
ANTHROPIC_API_KEY=fake-profile-cred
HOME=/home/tester
LANG=C.UTF-8
PATH=/opt/homebrew-sim/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
S1_PROFILE_MARK=from-profile
SSH_AUTH_SOCK=/tmp/fake-agent.sock
XDG_RUNTIME_DIR=/run/user/1001
--- daemon health:
Daemon:    running
  Socket:  rk-daemon
  Session: rk-daemon (window: serve)
  Target:  =rk-daemon:=serve


##### H3b: linger OFF, restart, no login
user@1001: inactive
tmux sock dir: ls: cannot access '/tmp/tmux-1001': No such file or directory
--- simulate login (start user@1001, as pam_systemd would)
user@1001: active
unit: Result=success ActiveState=active SubState=exited 
_rk-ctl: 1 windows (created Wed Nov 11 07:52:01 2026)
rk-code-server: 1 windows (created Wed Nov 11 07:52:00 2026) (attached)
rk-daemon: 1 windows (created Wed Nov 11 07:52:00 2026)
--- simulate last logout (stop user@1001) with KillMode=process
user@1001: failed
no server running on /tmp/tmux-1001/rk-daemon
procs:
251 /opt/homebrew-sim/bin/rk daemon start
```

### Cron entry after a restart

```
##### R4: cron entry whose target server vanishes across a restart
0afq operator tick [every 1m -> role:operator]
--- list before:
ID    NAME           SCHEDULE  TARGET         DELIVER    FLAGS  LAST-FIRED
0afq  operator tick  every 1m  role:operator  immediate  -      -
/home/tester/.local/state/hexokit/cron:
opsrv.yaml
--- 'reboot' (container restart); linger is OFF now, so re-enable to mimic a boot-started daemon
daemon: Daemon:    running
tmux servers: rk-daemon 
--- list after:
ID    NAME           SCHEDULE  TARGET         DELIVER    FLAGS  LAST-FIRED
0afq  operator tick  every 1m  role:operator  immediate  -      -
--- tick x2:
tick: 0 servers swept, 0 fires, 1 diagnostics
rc=0
tick: 0 servers swept, 0 fires, 1 diagnostics
rc=0
tick: 0 servers swept, 0 fires, 1 diagnostics
--- list after ticks:
ID    NAME           SCHEDULE  TARGET         DELIVER    FLAGS  LAST-FIRED
0afq  operator tick  every 1m  role:operator  immediate  -      -
opsrv alive? error connecting to /tmp/tmux-1001/opsrv (No such file or directory)
/home/tester/.local/state/hexokit/cron:
opsrv.yaml
```
