# Intake: Daemon Autostart Docs

**Change**: 261112-abvo-daemon-autostart-docs
**Created**: 2026-11-12

## Origin

> Implement step A4 (run-kit half only) of fab/plans/sahil/26-11-11-rk-daemon-autostart.md: docs for `rk daemon autostart on|off|status`. Read that plan (Goal, Decisions, brief A4) first. A1 (Linux systemd, #1123), A2 (macOS LaunchAgent, #1124) and A3 (doctor row + UI status line, #1127) are all merged on main — document what actually shipped by reading the code and docs/memory/run-kit/daemon-autostart.md, not the plan's guesses: the `rk skill` core bundle (one line under Capabilities), the site docs, and the daemon-lifecycle memory (including that the reboot hole is closed, and the lingering caveat on Linux). Scope is run-kit only: the plan's fab-kit half (operator docs in the fab-kit repo that still describe the reboot hole / the 2026-09-03 pulse plan's OS-timer advice) is a separate repo — do NOT touch it; list it in the PR body as a follow-up. Docs only, no behavior change. Never enable autostart or lingering on this machine. Once the intake is done, continue with /fab-fff.

One-shot invocation from the operator, followed by a lane brief (rig safety, evidence table, CI-to-green, ready/review, report format). No prior discussion in this session.

## Why

1. **Problem**: `rk daemon autostart on|off|status` shipped across #1123 (Linux), #1124 (macOS) and #1127 (doctor row + Host system-card line), but the user-facing docs still describe a world where the daemon is only ever started by hand. The agent skill bundle (`rk skill`) has no line for it, `docs/site/install.md` and the README list `rk daemon` as `start, restart, stop, status` only, and the daemon-lifecycle memory has a one-line pointer but never says the "reboot hole" (nothing starts the daemon after a reboot, so every rk cron entry — operator ticks, reminders, respawns — is silent) is now closable.
2. **Consequence if not fixed**: users and agents can't discover the feature; agents reading `rk skill` keep telling users to run `rk daemon start` after every reboot; the Linux lingering caveat (without `loginctl enable-linger` the unit only runs at login and is torn down at the last logout) is buried in a memory file nobody outside the repo reads.
3. **Approach**: document only what shipped — the code (`app/backend/cmd/rk/daemon_autostart.go`, `internal/daemon/autostart/`) and `docs/memory/run-kit/daemon-autostart.md` are the source of truth, not the plan's pre-implementation guesses (e.g. the plan says macOS `on` bootstraps; shipped code bootstraps only with `--now`).

## What Changes

Docs only. No Go, TypeScript, or behavior change.

### 1. `rk skill` core bundle — one line under `## Capabilities`

File: `docs/site/skill.md` (the source). The embedded copy `app/backend/cmd/rk/skill/skill.md` is synced from it by `scripts/sync-skill.sh` (`sync "docs/site/skill.md" "$DEST_DIR/skill.md"`) — run the sync (or the `just` recipe that wraps it) so both are byte-identical; never hand-edit only one.

Add exactly one bullet under `## Capabilities`, matching the existing one-line-per-subcommand style, e.g.:

```markdown
- `rk daemon autostart on [--now] | off | status [--json]` — register the daemon with the OS per-user service manager (systemd user unit on Linux, LaunchAgent on macOS) to start **once** at boot or login, through the user's login shell; never restarted, off by default. `off` never stops a running daemon. A user decision — never run `on` (or `loginctl enable-linger`) yourself; `status` is safe to read.
```

The exact wording is the apply agent's call but MUST: be one bullet; name the three verbs + `--now`/`--json`; say "once / never restarted"; and tell agents not to turn it on themselves (it changes host boot behavior; mirrors the existing `rk gui exec` bullet's "never run `rk gui on` yourself").

### 2. Site docs — `docs/site/install.md`

Add a section (suggested heading `## Start at boot or login`, placed after the install quick-start / tmux-version material and before or near `## Upgrade`) covering what shipped:

- `rk daemon autostart on` registers; `on --now` also starts it now through the service manager (a no-op when already running); `off` unregisters and never stops the running daemon; `status` shows registered / enabled / boot-vs-login / last start result, with hints. All idempotent; `--json` on each.
- Started **once**, never supervised: a crashed daemon stays down until `rk daemon start`. Off by default.
- **Linux**: systemd user unit `hexokit-daemon.service` at `~/.config/systemd/user/`. Starts at **boot** only with lingering (`loginctl enable-linger $USER`, a one-time privileged step `on` never runs; `status` prints the command when lingering is off). Without lingering it starts at first login and is torn down at the last logout. Requires a systemd user manager — otherwise the verbs fail with `systemd not found`.
- **macOS**: LaunchAgent `ai.shll.hexokit.daemon` at `~/Library/LaunchAgents/ai.shll.hexokit.daemon.plist`; starts at **login** (a boot-time LaunchDaemon would run as root). Logs to `<state home>/logs/autostart.log`.
- **Environment caveat**: the daemon is started through the login shell (`<shell> -lc`), so it gets what the login profile sets (`~/.zprofile`, `~/.bash_profile` / `~/.profile`), not what only `~/.zshrc` / `~/.bashrc` set. PATH, credentials and `TMUX_TMPDIR` exports belong in the login profile — agents born later inherit this environment.
- Where it shows up: `rk doctor` has a `daemon autostart` row; the Host page's HexoKit system card has a read-only `autostart` row. Both are read-only — enabling stays the CLI.
- Desktop app does not expose the switch; starting from both the app and the LaunchAgent ends with one daemon.

Also a short pointer in the install quick-start near `rk daemon start` (one sentence: "To start it automatically at boot or login, see [Start at boot or login](#start-at-boot-or-login)").

### 3. README

`README.md` is the published landing page and lists the daemon subcommands twice — line ~114 ("use the `rk daemon` subcommands (`start`, `restart`, `stop`, `status`)") and the command table row (`| rk daemon | Manage the background daemon (start, restart, stop, status). |`). Add `autostart` to both, with the table row staying one line, and a one-sentence pointer to the install guide section. Check `shll standards` (Constitution § Toolkit Standards) for the README/site rules before editing.

### 4. Daemon-lifecycle memory — `docs/memory/run-kit/daemon-lifecycle.md`

The `rk daemon autostart` bullet already exists (line 14). Add a short paragraph (e.g. "**Boot and reboot**") stating:

- Without autostart nothing starts the daemon after a reboot (the "reboot hole" — named in the 2026-09-03 operator pulse plan): every rk cron entry, including the operator's, stays silent until someone runs `rk daemon start`.
- `rk daemon autostart on` closes it: the OS starts the daemon once at boot (Linux with lingering) or login (Linux without lingering, macOS), via `rk daemon start --if-not-running` through the login shell; never restarted (Self-Improvement Safety / no supervisor loop still holds).
- **Linux lingering caveat**: without `loginctl enable-linger <user>` the unit runs at first login, not boot, and stopping the user manager at the last logout tears the daemon down even under `KillMode=process`. `on` never enables lingering; `status`/`rk doctor` surface it (`on (login only — enable lingering for boot)`).
- Still open after a reboot (from S1, out of scope): cron entries whose target tmux server is gone are skipped (`server-not-live`); `--if-absent respawn` only helps inside a live server.
- Not yet exercised on a real machine (plan step A5, with the user): real reboot, lingering, real macOS run.

Link to [daemon-autostart](/run-kit/daemon-autostart.md) for detail rather than duplicating it. Hydrate also adds a changelog row via the normal hydrate flow.

### Out of scope (PR-body follow-up)

- **fab-kit repo**: the operator docs that still describe the reboot hole as open and carry the 2026-09-03 pulse plan's interim OS-timer advice should point to `rk daemon autostart`. Separate repo — do NOT touch; list as a follow-up in the PR body.
- No change to `docs/memory/run-kit/daemon-autostart.md` beyond what hydrate needs (it already documents the shipped behavior).
- No enabling of autostart or lingering on this machine; no `rk serve`, no daemon restarts.

## Affected Memory

- `run-kit/daemon-lifecycle`: (modify) add a "Boot and reboot" paragraph — the reboot hole is closed by `rk daemon autostart`, the Linux lingering caveat, what stays open (cron entries on a vanished server), pointer to daemon-autostart

## Impact

- `docs/site/skill.md` + synced `app/backend/cmd/rk/skill/skill.md` (embedded in the binary — `rk skill` output changes; any Go test that asserts sync/byte-identity must stay green via `just test-backend`)
- `docs/site/install.md`, `README.md`
- `docs/memory/run-kit/daemon-lifecycle.md` (+ generated `log.md`/`index.md` via `fab docs-index` during hydrate)
- Evidence: nothing observable in the UI or shell → `No recording: docs-only change`; validation = `scripts/sync-skill.sh` parity, `just test-backend` (skill embed tests), link/anchor check of new install.md section.

## Open Questions

- None blocking. Exact placement of the install.md section and wording of the skill line are apply-time choices within the constraints above.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is run-kit only; fab-kit operator docs are a PR-body follow-up | Stated explicitly in the request | S:95 R:90 A:95 D:95 |
| 2 | Certain | Docs only — no Go/TS behavior change, no autostart/lingering enabled on this machine | Stated explicitly in the request and plan rule 3 | S:95 R:90 A:95 D:95 |
| 3 | Certain | Document shipped behavior from code + daemon-autostart memory, not the plan (e.g. macOS bootstraps only with `--now`) | Stated explicitly; memory DD "Bootstrap only with --now on macOS" confirms divergence | S:90 R:85 A:90 D:90 |
| 4 | Certain | Edit `docs/site/skill.md` and sync to `app/backend/cmd/rk/skill/skill.md` via `scripts/sync-skill.sh` | Sync script names docs/site as source; files are currently identical | S:80 R:90 A:95 D:90 |
| 5 | Confident | Skill line tells agents never to run `autostart on` / `enable-linger` themselves | Mirrors existing `rk gui` bullet ("never run `rk gui on` yourself"); autostart changes host boot behavior and is off-by-default opt-in | S:60 R:85 A:75 D:70 |
| 6 | Confident | Site docs = a new section in `docs/site/install.md` plus a quick-start pointer | install.md is the page covering `rk daemon start`, upgrade and the desktop app; no daemon-specific site page exists | S:65 R:90 A:75 D:70 |
| 7 | Confident | Also update README's two `rk daemon` verb lists | README is the published landing and enumerates daemon verbs; leaving it stale contradicts the new section — but it was not named explicitly | S:45 R:90 A:60 D:55 |
| 8 | Certain | Memory change = a "Boot and reboot" paragraph in daemon-lifecycle.md linking to daemon-autostart.md, not duplicating it | Request names daemon-lifecycle memory, reboot hole closed, lingering caveat; daemon-autostart.md already holds detail | S:75 R:90 A:80 D:75 |
| 9 | Certain | PR evidence: `No recording: docs-only change` | Constitution § PR Evidence exempts documentation; lane brief L2 last row | S:85 R:90 A:95 D:90 |

9 assumptions (6 certain, 3 confident, 0 tentative, 0 unresolved).
