# Plan: Daemon Autostart Docs

**Change**: 261112-abvo-daemon-autostart-docs
**Intake**: `intake.md`

## Requirements

### Agent skill: `rk skill` core bundle

#### R1: One Capabilities line for `rk daemon autostart`
The core bundle `docs/site/skill.md` SHALL carry exactly one new bullet under `## Capabilities` for `rk daemon autostart on [--now] | off | status [--json]`, stating that it starts the daemon once at boot or login (never restarted, off by default), that `off` never stops a running daemon, and that agents MUST NOT turn it on (or enable lingering) themselves. The embedded copy `app/backend/cmd/rk/skill/skill.md` MUST be byte-identical (refreshed via `scripts/sync-skill.sh`), and the bundle MUST stay within the 150-line budget.

- **GIVEN** an agent runs `rk skill`
- **WHEN** it reads `## Capabilities`
- **THEN** it finds one `rk daemon autostart` bullet with the verbs, the once-only semantics, and the do-not-enable-yourself rule
- **AND** `TestSkillTopicsMatchCanonical` and `TestSkillTopicsWithinLineBudget` pass

### Site docs: install guide and README

#### R2: Install guide documents autostart as shipped
`docs/site/install.md` SHALL gain a `## Start at boot or login` section describing the shipped behavior: the three verbs and `--now`/`--json`; start-once/no-supervision/off-by-default; Linux (`hexokit-daemon.service` user unit, boot only with `loginctl enable-linger`, which `on` never runs, otherwise login-to-last-logout; systemd required); macOS (LaunchAgent `ai.shll.hexokit.daemon`, login, log at `~/.local/state/hexokit/logs/autostart.log`-equivalent state-home path); the login-shell environment caveat; where it is shown (`rk doctor` row, Host system card row — both read-only); the desktop app not exposing the switch. The quick-start SHALL point to it.

- **GIVEN** a user reading the install guide after `rk daemon start`
- **WHEN** they want the daemon to come back after a reboot
- **THEN** a pointer leads to the new section, which tells them `rk daemon autostart on` and, on Linux, the lingering step for boot-time start

#### R3: README daemon verb lists include `autostart`
`README.md`'s daemon prose and its command-table `rk daemon` row SHALL list `autostart` alongside `start`, `restart`, `stop`, `status`, with a link to the install section (natural `docs/site/install.md#…` path per readme-extraction rule 5/8).

- **GIVEN** a reader of the README command table
- **WHEN** they look up `rk daemon`
- **THEN** `autostart` is listed

### Memory: daemon lifecycle

#### R4: Daemon-lifecycle memory records the reboot hole as closable
`docs/memory/run-kit/daemon-lifecycle.md` SHALL state (hydrate) that without autostart nothing starts the daemon after a reboot (the reboot hole), that `rk daemon autostart on` closes it, the Linux lingering caveat, what stays open (cron entries whose tmux server is gone are skipped as `server-not-live`), and that a real reboot is unverified until plan step A5 — linking to daemon-autostart rather than duplicating it.

- **GIVEN** a future agent reading daemon-lifecycle memory
- **WHEN** it asks what happens after a reboot
- **THEN** it learns the hole, the fix, and the lingering caveat

### Non-Goals

- fab-kit operator docs (reboot hole / OS-timer advice) — separate repo; PR-body follow-up
- Any Go/TS behavior change; enabling autostart or lingering on this machine
- Rewriting `daemon-autostart.md` — it already documents the shipped behavior

## Tasks

### Phase 2: Core Implementation

- [x] T001 Add the `rk daemon autostart` bullet under `## Capabilities` in `docs/site/skill.md`, then run `scripts/sync-skill.sh` to refresh `app/backend/cmd/rk/skill/skill.md` <!-- R1 -->
- [x] T002 Add `## Start at boot or login` to `docs/site/install.md` and a one-sentence pointer in the install quick-start <!-- R2 -->
- [x] T003 Add `autostart` to the two `rk daemon` verb lists in `README.md`, with a link to the install section <!-- R3 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Validate: `just test-backend` (skill drift guard + line budget), install.md anchor resolves, README/site links conform to readme-extraction <!-- R1 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `docs/site/skill.md` has exactly one `rk daemon autostart` bullet under `## Capabilities`, and `app/backend/cmd/rk/skill/skill.md` is byte-identical
- [x] A-002 R2: `docs/site/install.md` has a `## Start at boot or login` section matching shipped behavior (verbs, Linux unit + lingering, macOS LaunchAgent, login-shell caveat, doctor/system-card visibility) and a quick-start pointer
- [x] A-003 R3: README's daemon prose and command-table row list `autostart`
- [ ] A-004 R4: daemon-lifecycle memory states the reboot hole, the fix, the Linux lingering caveat, and what stays open — pending-by-design: R4 is delivered by the hydrate stage, not apply

### Behavioral Correctness

- [x] A-005 R2: No doc claims the plan's unshipped behavior (e.g. macOS `on` bootstrapping without `--now`, `on` enabling lingering, any restart/supervision)

### Scenario Coverage

- [x] A-006 R1: `just test-backend` passes, including `TestSkillTopicsMatchCanonical` and `TestSkillTopicsWithinLineBudget` (core ≤ 150 lines) — skill tests pass (core 118 lines); unrelated environment-dependent flakes seen in `rk/internal/snapshot` (TempDir cleanup) and `cmd/rk` `TestPortPinRowRealPolicyValues`, different on each run, no Go in this diff

### Edge Cases & Error Handling

- [x] A-007 R2: The Linux no-systemd failure and the lingering-off login-only behavior are documented

### Code Quality

- [x] A-008 Pattern consistency: new skill bullet and doc sections follow the surrounding one-line-per-subcommand / prose style
- [x] A-009 No unnecessary duplication: memory links to daemon-autostart instead of restating it; site docs don't copy the unit file verbatim — site-docs half met; memory half lands with R4 at hydrate
- [x] A-010 Toolkit standards: README/site links follow readme-extraction (relative links only into `docs/site/`), skill bundle stays static and ≤150 lines

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Memory edit (R4) lands at hydrate, not as an apply task | Hydrate owns `docs/memory/` writes in the fab pipeline | S:80 R:90 A:95 D:90 |
| 2 | Confident | Install section heading `## Start at boot or login`, placed before `## Upgrade` | Sits after install + tmux-version material, where a user setting up the daemon reads | S:60 R:95 A:75 D:70 |
| 3 | Confident | Docs refer to the state-home log path as `~/.local/state/hexokit/logs/autostart.log` | Matches the state-home path already used in install.md for code-server (`~/.local/state/hexokit/...`) | S:60 R:90 A:75 D:70 |

3 assumptions (1 certain, 2 confident, 0 tentative).
