# HexoKit daemon autostart — start rk-daemon at boot or login, once, without supervising it

> Plan doc — written 2026-11-11 from a `/fab-discuss` session in fab-kit. Independent of fab-kit's
> `fab/plans/sahil/26-11-10-operator-to-hexokit.md` and can run in parallel with it. Facts below were
> verified against run-kit `origin/main` (`docs/memory/run-kit/daemon-lifecycle.md`,
> `fab/project/constitution.md`, `rk daemon --help`, `rk --help`) and fab-kit
> `fab/plans/sahil/26-09-03-operator-pulse-plan.md`.

**Problem.** Nothing starts the HexoKit daemon after a reboot. `rk daemon` has only
`start | stop | restart | status | run`, and `rk daemon start` is run by hand. Until someone runs
it, every rk cron entry is silent: no operator ticks, no reminders, no respawns, and nothing says
so. The operator pulse plan (2026-09-03) named this "the reboot hole" and proposed a run-kit
"rk-daemon boot unit", but it was never filed. It matters more once the operator lives in the
daemon (fab-kit `fab/plans/sahil/26-11-10-operator-to-hexokit.md`): a daemon that isn't running then means no operator at
all.

---

## Goal

```
rk daemon autostart on      # register: start the daemon once at boot (Linux) / login (macOS)
rk daemon autostart status  # registered? enabled? starts without a login? last start result?
rk daemon autostart off     # remove the registration
```

- The OS starts the daemon **once**. It never restarts it. A crashed daemon stays down until a
  person runs `rk daemon start`, as today.
- The daemon comes up with the **same environment** a manual `rk daemon start` from the user's
  shell would give it, because every agent born later inherits it.
- Off by default. Nothing changes for a user who never runs `autostart on`.

---

## Decisions already taken (do not reopen at intake)

| Decision | Choice | Why |
|---|---|---|
| Start, don't supervise | Start once at boot/login. No `Restart=` (systemd) and no `KeepAlive` (launchd) | run-kit's constitution allows no supervisor loop ("There is no supervisor loop"); starting once is not supervision (same reasoning as the 2026-09-03 pulse plan) |
| Mechanism | The OS's per-user service manager: a **systemd user unit** on Linux, a **LaunchAgent** on macOS. No root, no system-wide unit | Per-user, no `sudo`, removable by the user |
| Who writes the files | A new `rk daemon autostart on\|off\|status` verb | Works for Homebrew and non-Homebrew installs; rk controls the environment and the no-restart rule. `brew services` was considered and rejected: it is tied to the Homebrew install, and the service it defines starts with a bare service environment |
| Environment | The unit runs `rk daemon start` **through the user's login shell** (`$SHELL -lc`) | The rk-daemon tmux server copies the environment of the process that births it, and every later pane and agent inherits that. Started bare by systemd or launchd, it would have no Homebrew `PATH`, no `SSH_AUTH_SOCK` and none of the provider credentials the agent CLIs read from shell profiles. rk already repairs the locale (`tmux.EnsureUTF8Locale`); nothing repairs the rest |
| macOS timing | At **login**, not at boot | A boot-time job on macOS (LaunchDaemon) runs as root. Per-user means login |
| Linux timing | At **boot** when lingering is enabled, otherwise at login | A user unit starts at boot only with `loginctl enable-linger <user>`, which is a one-time privileged step. `autostart on` never runs it; `status` reports whether it's missing and prints the command |
| Default | Off | Nothing should start on a machine where the user didn't ask for it |

---

## Known hazards to verify in S1

1. **The service manager can kill tmux.** The daemon runs inside the `rk-daemon` tmux server,
   which `rk daemon start` spawns and then exits. A systemd unit whose main process exits may
   have its leftover processes killed, depending on `Type=` and `KillMode=`. A launchd job may
   have its process group killed when it exits, unless `AbandonProcessGroup` is set. The daemon
   must outlive the unit/job that started it, and stopping or disabling the unit must not kill
   tmux (run-kit Principle VI).
2. **Environment provenance.** Confirm that a login-shell start gives the tmux server the same
   `PATH`, `SSH_AUTH_SOCK`, locale and provider credential variables as a manual start, and find
   what a non-interactive login shell misses (anything set only in `.zshrc` / `.bashrc`).
3. **Boot without a login** (Linux): with lingering on, the unit runs before any login. Check the
   resulting `HOME`, `XDG_*`, `TMUX_TMPDIR` and the tmux socket path, which must match what later
   interactive shells use, or `rk` and the UI will look for a different server.
4. **Restarting the service manager**: `systemctl --user daemon-reload` and a re-login must not
   start a second daemon. `rk daemon start` is already port-guarded; confirm the unit's result
   reads as success when the daemon is already running.

---

## Rules for the operator executing this plan

1. All steps are in **run-kit**. Each step is one fab change started with `/fab-new` in a
   run-kit worktree, using the step's Brief below as the description, with this plan's path so
   the agent can read it.
2. No dependency on fab-kit's `26-11-10-operator-to-hexokit.md`. The two plans can run side by side. They
   touch different packages: this one `internal/daemon` and `cmd/rk/daemon*`, that one
   `internal/operator`, `internal/cron` and the drawer.
3. Never enable autostart, enable lingering, or reboot on the **live** machine. S1 runs in a
   throwaway VM or container. A live machine is switched on only at **A5**, with the user.
4. Merge mode: `cherry-pick-ladder` (PRs created, merged after the user's review).

---

## Steps and dependencies

| ID | Repo | Step | Depends on | Size | Gate |
|---|---|---|---|---|---|
| **S1** | run-kit | Spike: unit and LaunchAgent shapes that survive the four hazards | — | S | — |
| **A1** | run-kit | `rk daemon autostart on\|off\|status` — Linux (systemd user unit) | S1 | M | — |
| **A2** | run-kit | Same verbs on macOS (LaunchAgent) | S1 | M | — |
| **A3** | run-kit | `rk doctor` row + daemon-status line in the UI | A1 | S | — |
| **A4** | run-kit | Docs: `rk skill`, site docs, the reboot hole closed in operator docs | A1, A2 | S | — |
| **A5** | — | Turn it on, on the user's machines; one real reboot test | A1 (Linux) / A2 (macOS) released | S | **user gate** |

A1 and A2 can run in parallel after S1. A3 can start once A1 is merged.

```
S1 ──┬── A1 ──┬── A3
     │        ├── A4
     └── A2 ──┘    └── A5 (user gate, after release)
```

---

## Briefs

### S1 — Spike (run-kit)

Throwaway. In a fresh Linux VM (systemd) and on a macOS account:
- Try candidate unit/plist shapes and record which ones survive hazards 1–4. For Linux, compare
  `Type=oneshot` + `RemainAfterExit=yes`, `Type=forking`, and `KillMode=process`. For macOS, try
  `RunAtLoad` + `AbandonProcessGroup`.
- For each: does the tmux server outlive the start? Does `systemctl --user stop/disable` or
  `launchctl bootout` leave it running? Is the environment the same as a manual start (diff
  `tmux -L rk-daemon show-environment -g` against a manual start)? What happens on a real boot,
  with and without lingering?
- Note what happens after a reboot to rk cron entries whose target tmux server no longer exists
  (for example the operator entry's `--if-absent respawn`). Record it; fixing it is out of scope.
- Output: a findings file under `fab/plans/` with the winning shapes, verbatim.

### A1 — Linux autostart (run-kit)

- `rk daemon autostart on`: write `~/.config/systemd/user/<unit>.service` (name decided at
  intake), using S1's winning shape, with `ExecStart=<login shell> -lc '<absolute rk path> daemon
  start'` and no `Restart=`. Then `systemctl --user daemon-reload` and `enable` it. Don't start
  it now unless `--now` is given.
- Resolve the `rk` path so it survives `brew upgrade` (the Homebrew opt symlink, not the Cellar
  path; see `StartWithBinary` in daemon-lifecycle).
- `off`: disable and delete the unit. It must never stop the running daemon.
- `status`: registered, enabled, lingering on/off (with the `loginctl enable-linger` command when
  off), and the unit's last result. `--json` with the standard `{ok,result}` envelope.
- All three are idempotent. Every subprocess goes through `exec.CommandContext` with a timeout
  (Principle I). No systemd → a clear error naming the platform.
- Tests behind seams for the systemctl/loginctl calls and the file writes.

### A2 — macOS autostart (run-kit)

Same verbs and flags as A1:
- `on`: write `~/Library/LaunchAgents/<label>.plist` using S1's shape (`RunAtLoad`, no
  `KeepAlive`, plus whatever keeps the tmux server alive), with `ProgramArguments` running the
  login shell, then `launchctl bootstrap gui/<uid>`.
- `off`: `bootout` and delete the plist, without stopping the daemon.
- `status`: as A1, minus lingering.
- Coordinate with the desktop app (`app/desktop`), which can also start the daemon: decide at
  intake whether the app should offer this switch, and make sure both starting together is
  harmless.

### A3 — Visibility (run-kit)

- `rk doctor`: one row, "Daemon autostart: on (boot) / on (login only — enable lingering for
  boot) / off".
- The daemon-status surface in the UI shows the same fact. Any new UI control must also be a
  palette action (Principle V). No new page (Principle IV).

### A4 — Docs (run-kit + fab-kit)

- run-kit: `rk skill` core bundle (one line under Capabilities), site docs, daemon-lifecycle
  memory.
- fab-kit: the operator docs that describe the reboot hole as open (the 2026-09-03 pulse plan's
  interim OS-timer advice) point to `rk daemon autostart` instead. Docs only.

### A5 — Turn it on (user gate)

With the user, per machine: `rk daemon autostart on`, plus `loginctl enable-linger` on Linux
machines that reboot unattended. Reboot once. Confirm the daemon is up, the tmux server's
environment matches a manual start, and an agent started from the UI can find `claude`, `gh` and
its credentials.

---

## Open decisions (resolve at each step's intake)

| Step | Question |
|---|---|
| A1 | Unit name and launchd label (`hexokit-daemon` vs `rk-daemon`) |
| A1 | Should `on` also start the daemon now (`--now` default)? |
| A2 | Does the desktop app expose the switch, or only the CLI? |
| A3 | Is a UI toggle worth a settings-registry entry, or is a status line enough? |

## Non-goals

- Restarting a crashed daemon (no supervisor loop).
- Restoring user tmux sessions or agents after a reboot (layout snapshots are a separate concern).
- System-wide (root) units, and Windows.
