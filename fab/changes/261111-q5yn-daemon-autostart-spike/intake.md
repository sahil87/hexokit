# Intake: Daemon Autostart Spike (S1)

**Change**: 261111-q5yn-daemon-autostart-spike
**Created**: 2026-11-11

## Origin

> Execute the plan at fab/plans/sahil/26-11-11-rk-daemon-autostart.md

One-shot `/fab-new` invocation on branch `autostart-daemon`. The plan (committed in #1115) splits the work into S1 (spike), A1–A4 (implementation and docs) and A5 (user gate). Its Rules section says each step is **one fab change** started with `/fab-new`, and only S1 has no dependency (A1/A2 depend on S1, A3 on A1, A4 on A1+A2, A5 is a user gate). This intake therefore covers **S1 only**; A1–A5 are separate changes started once S1's findings are merged.

The plan's "Decisions already taken" table is binding and not reopened here: start-once (no `Restart=` / `KeepAlive`), a per-user systemd unit on Linux and a LaunchAgent on macOS, written by a new `rk daemon autostart on|off|status` verb, started through the user's login shell (`$SHELL -lc`), macOS at login, Linux at boot when lingering is on, off by default.

## Why

1. **Problem.** Nothing starts the HexoKit daemon after a reboot. `rk daemon start` is run by hand, and until it is, every rk cron entry (operator ticks, reminders, respawns) is silent and nothing says so. The 2026-09-03 operator pulse plan called this "the reboot hole". It matters more once the operator lives in the daemon, because a daemon that isn't running then means no operator at all.
2. **Consequence of not solving it.** A reboot silently disables all scheduled behaviour until a person notices.
3. **Why a spike first.** The plan's four hazards are all of the form "the service manager may do something to the tmux server that `rk daemon start` spawns". `rk daemon start` creates the `rk-daemon` tmux server and exits, so a unit or job whose main process exits can have its leftovers killed (systemd `KillMode`/`Type`, launchd process-group kill). Writing A1/A2 against a guessed unit shape risks shipping something that appears to work (`systemctl start` returns 0) and then loses the daemon on stop, disable or boot. The shapes must be verified empirically, and the winning ones recorded verbatim, before any Go code is written (the plan's own S1 definition).

## What Changes

S1 is a **throwaway experiment whose only deliverable is a findings file**. No Go code, no CLI surface, no change under `app/`, `docs/memory/` or `docs/specs/`.

### Deliverable

One markdown file under `fab/plans/` (suggested: `fab/plans/sahil/26-11-11-rk-daemon-autostart-s1-findings.md`, beside the plan) containing:

- The **winning unit shape for Linux**, verbatim (a complete `.service` file), and the **winning LaunchAgent plist for macOS**, verbatim, or an explicit statement that macOS was not tested (see Open Questions).
- A results matrix: each candidate shape × each hazard × pass/fail with the observed evidence (commands run, relevant output).
- The **environment diff** between a login-shell start and a manual start.
- The note on **cron entries after reboot** (below).
- Recommendations carried into A1/A2 intake (unit name, whether `on` should start now) as input only; the plan lists those as open decisions for A1's and A2's own intake.

### Experiments (from the plan's S1 brief and hazards 1–4)

Candidates, Linux (systemd user unit), all with `ExecStart=<login shell> -lc '<abs rk path> daemon start'` and **no `Restart=`**:

| Candidate | Shape |
|---|---|
| L1 | `Type=oneshot` + `RemainAfterExit=yes` |
| L2 | `Type=forking` |
| L3 | any of the above plus `KillMode=process` |

Candidate, macOS (LaunchAgent): `RunAtLoad=true`, no `KeepAlive`, with and without `AbandonProcessGroup=true`, `ProgramArguments` running the login shell.

For each candidate, answer:

1. **Hazard 1 — does the tmux server outlive the start?** After the unit/job runs `rk daemon start` and its main process exits, is `tmux -L rk-daemon` still alive and serving? Then `systemctl --user stop`, `systemctl --user disable` and `launchctl bootout`: does the tmux server survive each (constitution Principle VI)?
2. **Hazard 2 — environment provenance.** Diff `tmux -L rk-daemon show-environment -g` between a manual `rk daemon start` from an interactive shell and the unit-started daemon. Cover `PATH` (Homebrew), `SSH_AUTH_SOCK`, locale (`LANG`/`LC_*`; note rk already repairs this via `tmux.EnsureUTF8Locale`), and provider credential variables. Find what a **non-interactive login shell** (`$SHELL -lc`) misses compared with an interactive one — anything set only in `.zshrc`/`.bashrc` rather than `.zprofile`/`.profile`/`.bash_profile`.
3. **Hazard 3 — boot without a login (Linux).** With `loginctl enable-linger` on, the unit runs before any login. Record the resulting `HOME`, `XDG_*`, `TMUX_TMPDIR` and the tmux socket path, and confirm it matches the path later interactive shells (and `rk`, and the UI) use. Run once with lingering off to document login-only behaviour.
4. **Hazard 4 — manager restart.** `systemctl --user daemon-reload`, and a re-login, must not start a second daemon. Confirm the unit's result reads as success when the daemon is already running (`rk daemon start` is port-guarded; verify its exit code in that case).

### Cron-after-reboot note

Record what happens, after a reboot, to rk cron entries whose target tmux server no longer exists (for example the operator entry's `--if-absent respawn`). Record only; fixing it is out of scope.

### Where it runs (hard constraint)

Plan Rule 3: **never enable autostart, enable lingering, or reboot on the live machine.** S1 runs in a throwaway VM or container only. The current host has `docker` and a running systemd user manager; the user manager there is the live one and must not be used for the experiment. A container with a real systemd PID 1 (or a VM) is needed for the Linux half, including a genuine boot/lingering test. macOS cannot be exercised from this Linux host.

## Affected Memory

None. S1 produces a findings file under `fab/plans/` and changes no behaviour. The plan assigns the `daemon-lifecycle` memory update to A4, once `rk daemon autostart` exists.

## Impact

- **Files**: one new file under `fab/plans/sahil/`. Nothing in `app/`, `docs/memory/`, `docs/specs/`.
- **Consumers**: A1 (Linux autostart) and A2 (macOS autostart) read the findings; A4 docs derive from it.
- **Risk**: running the experiment on the live host would register or start a unit on the user's real machine; hence the throwaway-environment rule. Nothing else is affected.
- **PR evidence (constitution)**: docs-only, so the PR body states `No recording: documentation-only findings file, no UI/shell behaviour change`.

## Open Questions

- Is a macOS account available for the macOS half? If not, S1 ships the Linux findings and records macOS as untested with the candidate plist, and A2's intake carries the verification.
- Which throwaway environment: a systemd-as-PID-1 container on the current host (cheap, but a "real reboot" is only a container restart) or a full VM (a true boot, needed to prove the lingering-at-boot behaviour)?

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | This change covers S1 only; A1–A5 are separate later changes | Plan Rules: each step is one fab change, and only S1 has no dependency | S:90 R:85 A:95 D:90 |
| 2 | Certain | The plan's "Decisions already taken" table is not reopened | Plan states "do not reopen at intake" | S:95 R:70 A:95 D:95 |
| 3 | Certain | S1 produces only a findings file under `fab/plans/`; no Go code, memory or spec edits | Plan S1 brief: "Output: a findings file under `fab/plans/`" | S:90 R:90 A:95 D:90 |
| 4 | Certain | Experiments never run on the live machine's systemd/launchd, never enable lingering or reboot it | Plan Rule 3 | S:95 R:40 A:95 D:95 |
| 5 | Confident | Findings file lives at `fab/plans/sahil/26-11-11-rk-daemon-autostart-s1-findings.md` beside the plan | Plan says only "under `fab/plans/`"; sibling placement matches existing plan files | S:70 R:90 A:80 D:70 |
| 6 | Confident | Linux half runs in a systemd-as-PID-1 container or VM; docker is available on this host | `docker` found on PATH; plan requires a throwaway environment | S:65 R:80 A:70 D:60 |
| 7 | Tentative | If no macOS account is available, the macOS half is recorded as untested rather than blocking S1 | Plan lists macOS in S1, but this host is Linux and the A2 verification can absorb it <!-- assumed: macOS untested-with-candidate is acceptable if no Mac is reachable --> | S:45 R:75 A:50 D:45 |
| 8 | Confident | Not a micro change; proceed in fab | Plan mandates `/fab-new` per step, and the findings feed memory-impacting changes A1–A4 | S:75 R:80 A:85 D:75 |

8 assumptions (4 certain, 3 confident, 1 tentative, 0 unresolved).
