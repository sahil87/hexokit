# Plan: rk tab new launches its command through the user's interactive shell

**Change**: 261111-c8sc-tab-new-interactive-shell-wrap
**Intake**: `intake.md`

> Intake §1–§7 shipped first as hotfix PR #1125 (commit `74c30233`, which this branch is stacked on). R1–R4 below restate that behavior so review verifies it as shipped; T001 is the verification task for it. R5–R6 (intake §8) are this change's new implementation.

## Requirements

### Shell launch: interactive wrap

#### R1: One shared interactive-wrap composition
`internal/shellq` MUST expose `Interactive(cmd string) string` returning `${SHELL:-/bin/sh} -i -c <Quote(cmd)>`, and `riff.buildSkillShellString` MUST compose its layer 2 through it with byte-identical output.

- **GIVEN** a riff skill pane with launcher `claude` and prompt `/fab-discuss`
- **WHEN** `buildSkillShellString` composes the pane command
- **THEN** the output is byte-identical to the pre-change string `${SHELL:-/bin/sh} -i -c 'claude '\''/fab-discuss'\'''; exec "${SHELL:-/bin/sh}"`

#### R2: `rk tab new -- CMD…` runs through the user's interactive shell by default
`rk tab new` with a `--` command MUST compose `Interactive(QuoteArgv(args))`, then the `; exec "${SHELL:-/bin/sh}"` fallback unless `--no-shell-fallback`. Every argv token MUST still reach the process as one literal word.

- **GIVEN** a tmux server whose environment lacks a variable that the user's interactive rc file exports
- **WHEN** `rk tab new -- sh -c 'printf %s "$VAR" > OUT'` spawns a window
- **THEN** OUT contains the rc-exported value
- **AND** a token `$(echo pwned)` still arrives as the literal string `$(echo pwned)`

#### R3: `--no-shell-profile` opt-out
`--no-shell-profile` MUST compose the previous raw form (`QuoteArgv` plus the optional fallback), is orthogonal to `--no-shell-fallback`, and without a `--` command MUST be a usage error (exit 2): `--no-shell-profile needs a command after --`.

- **GIVEN** the same server
- **WHEN** `rk tab new --no-shell-profile -- …` spawns a window
- **THEN** the command sees only the tmux server's environment (the rc-exported variable is unset)

#### R4: Surface documentation
The `rk tab new` `Use`/`Long`/flag help, the skill-bundle pair (`docs/site/skill.md` and `app/backend/cmd/rk/skill/skill.md`, byte-identical) and the `docs/specs/ui-state.md` synopsis MUST describe the interactive default and `--no-shell-profile`.

- **GIVEN** `rk tab new --help`
- **WHEN** a caller reads it
- **THEN** it names the `${SHELL:-/bin/sh} -i -c` default, that the quoted command is not alias-expanded, and the `--no-shell-profile` opt-out

### Readiness: login wall

#### R5: A Claude login wall classifies as parked
`inject.AwaitReady` MUST return a `ParkedError` (the existing parked contract, so `rk mux await --ready` / `rk tab new --ready` report `parked %N` with the snippet on stderr, and `DeliverWhenReady` never delivers) when the captured screen carries Claude's login-wall line — a line whose content, trimmed, ends with `Not logged in · Run /login` and is preceded only by whitespace or by at least two spaces (the right-aligned notice slot). The check MUST gate BOTH ready verdicts: the state path (hooks may fire on an unauthenticated boot) and the echo path (the composer still renders). The `ParkedError.Snippet` MUST be the login-wall text itself.

- **GIVEN** a pane whose screen shows `                Not logged in · Run /login` above a live `❯` composer
- **WHEN** `AwaitReady` runs, with or without a state reader that reports a state
- **THEN** it returns a `ParkedError` whose snippet is `Not logged in · Run /login`, and no sentinel is pasted

Live measurement at apply (Claude Code v2.1.311): hooks stamp `idle` ~1.4 s after boot, while the notice paints asynchronously 2–20 s after boot. The check is therefore a best-effort safety net: it classifies a pane on which the notice is already drawn (a later `--ready`, a slow-booting delivery), and an earlier verdict cannot see it. The root-cause fix is R2. Readiness captures carry ANSI escapes (`capture-pane -e`), so the matcher MUST strip them first.

- **GIVEN** a pane whose transcript text merely mentions the phrase inline (e.g. `● Both agents report "Not logged in · Run /login".`)
- **WHEN** `AwaitReady` runs
- **THEN** the line does not match and readiness classifies as before

#### R6: Wall-tolerant waits keep their contract
Under `ReadyOpts.WaitThroughWalls` a login wall MUST NOT end the wait: polling continues, and at the deadline the error is the login-wall `ParkedError` when the last capture still shows the wall. With no wall on screen, every existing readiness path (state, echo, parked, narrow, gone, deadline) MUST behave exactly as before.

- **GIVEN** `WaitThroughWalls: true` and a pane that stays on the login wall
- **WHEN** the deadline expires
- **THEN** `AwaitReady` returns the login-wall `ParkedError`

### Non-Goals

- riff cmd-type panes (`buildCmdShellString`) stay unwrapped — existing rk-riff decision.
- No tmux-server environment fix and no `~/.zshenv` guidance — rejected in the intake.
- No agent-specific branching beyond the one signature string: Codex and other agents never match it.

### Design Decisions

#### Per-launch interactive wrap for `rk tab new`
**Decision**: `rk tab new -- CMD…` composes `${SHELL:-/bin/sh} -i -c '<QuoteArgv>'` by default through the shared `shellq.Interactive`, with `--no-shell-profile` as the opt-out.
**Why**: tmux runs a window's shell-command under a non-interactive `default-shell -c`, so rc-only exports (auth tokens) were missing whenever the tmux server started non-interactively. Riff, operator, tutorial and fab dispatch already wrap; re-reading the profile per launch also picks up a rotated token.
**Rejected**: fixing the tmux server's environment (captured once at server start — stale on rotation, fragile under systemd/launchd autostart); moving exports to `~/.zshenv` (zsh-only, user-side).
*Introduced by*: 261111-c8sc-tab-new-interactive-shell-wrap

#### Login wall gates both ready verdicts
**Decision**: `inject.AwaitReady` checks every successful capture for the right-aligned `Not logged in · Run /login` line before returning `ReadyByState` or probing, and classifies it as `ParkedError`.
**Why**: an unauthenticated Claude boots a full TUI — the composer echoes and hooks may fire — so both existing signals report ready and a delivery lands in an agent that cannot act. The shared classifier gives every `--ready` consumer (including `fab dispatch ready` via `rk mux await --ready`) the verdict at once.
**Rejected**: a `rk tab new`-only check (leaves fab dispatch, operator kickoff and riff delivery blind); matching the phrase anywhere on screen (a transcript that quotes it would refuse delivery to a healthy agent).
*Introduced by*: 261111-c8sc-tab-new-interactive-shell-wrap

## Tasks

### Phase 1: Setup

- [x] T001 Verify the hotfix commit `74c30233` (#1125) on this branch satisfies R1–R4: `app/backend/internal/shellq/shellq.go` + `shellq_test.go`, `app/backend/internal/riff/shell.go`, `app/backend/cmd/rk/tab_new.go` + `tab_test.go`, `docs/site/skill.md` = `app/backend/cmd/rk/skill/skill.md`, `docs/specs/ui-state.md` <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 Add the login-wall signature constant and a pure `loginWallLine(capture string) (string, bool)` matcher (right-aligned-notice rule) to `app/backend/internal/inject/ready.go`, with table tests in `app/backend/internal/inject/ready_test.go` (whole-line match, right-aligned match, inline transcript mention rejected, absent) <!-- R5 -->
- [x] T003 Wire the matcher into `AwaitReady` in `app/backend/internal/inject/ready.go`: capture before the state verdict, return `&ParkedError{Snippet: <wall text>}` on a wall (state and settle paths), keep `ReadyByState` when the capture errors non-fatally, and under `WaitThroughWalls` record the wall as the parked frame and keep polling; add AwaitReady tests (wall + state, wall + echo-capable screen with no paste, WaitThroughWalls deadline returns the wall) <!-- R5 R6 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Name the login wall in the parked-verdict docs: the `ErrParked`/`ParkedError` doc comments, the `rk mux await --ready` `Long` text and header comment in `app/backend/cmd/rk/mux_await.go` (a `Not logged in · Run /login` screen is `parked` even though its composer echoes) <!-- R5 -->
- [x] T005 Run `just test-backend` and compare failures against the pre-existing environmental set; validate with the built binary that `rk mux await --ready` on a minimal-env Claude pane reports `parked` with the login-wall snippet, and on a logged-in pane reports `ready` <!-- R5 R6 -->

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `shellq.Interactive` exists and `buildSkillShellString` delegates to it; existing riff/operator/tutorial golden tests pass unchanged
- [ ] A-002 R2: `rk tab new -- CMD` composes `Interactive(QuoteArgv(args))` plus the fallback by default
- [ ] A-003 R3: `--no-shell-profile` restores the raw composition and is a usage error without a command
- [ ] A-004 R4: help text, skill-bundle pair (byte-identical) and ui-state synopsis document the default and the opt-out
- [ ] A-005 R5: `AwaitReady` returns a `ParkedError` with snippet `Not logged in · Run /login` for a login-wall screen on both the state and echo paths
- [ ] A-006 R6: under `WaitThroughWalls` a persistent login wall is returned as the parked verdict at the deadline

### Behavioral Correctness

- [ ] A-007 R2: a pane spawned by `rk tab new` sees rc-exported variables (`TestTabNewCommandSeesShellProfile`), and tokens stay literal (`TestTabNewCommandRunsArgvVerbatim`, `TestInteractiveRoundTripKeepsTokensLiteral`)
- [ ] A-008 R5: the login-wall check runs before any sentinel paste — no `set-buffer` call on a walled pane

### Scenario Coverage

- [ ] A-009 R5: matcher table tests cover whole-line, right-aligned, inline-transcript (rejected) and absent cases
- [ ] A-010 R5: built-binary check: `rk mux await --ready` on a minimal-env Claude pane prints `parked %N` with the snippet on stderr

### Edge Cases & Error Handling

- [ ] A-011 R6: with no wall on screen every pre-existing `ready_test.go` case passes unchanged (state, echo, parked, narrow, gone, deadline)
- [ ] A-012 R5: a capture error while state is present still returns `ReadyByState` (unless it matches `IsGone`)

### Code Quality

- [ ] A-013 Pattern consistency: new code follows the surrounding `inject`/`shellq` naming, doc-comment and pure-helper patterns
- [ ] A-014 No unnecessary duplication: the interactive wrap has exactly one implementation (`shellq.Interactive`); the wall reuses `ParkedError`
- [ ] A-015 Subprocess safety: all tmux interaction stays behind the injected `Tmux` interface / `exec.CommandContext` with timeouts — no shell strings built from user input
- [ ] A-016 Magic strings: the login-wall signature is a named constant
- [ ] A-017 Comment discipline: comments state constraints and why, never narrate or cite change IDs / PR numbers
- [ ] A-018 Tests: new behavior (wrap, opt-out, login wall) has tests

### Security

- [ ] A-019 R2: the tmux shell-command positional is built only from rk-quoted argv plus fixed literals (Constitution I)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Match the wall only on a line whose trimmed content ends with the signature and is preceded by nothing or by ≥ 2 spaces | The reproduced screen right-aligns the notice; requiring the notice slot keeps a transcript that quotes the phrase from refusing delivery to a healthy agent | S:70 R:85 A:75 D:70 |
| 2 | Confident | Capture before the state verdict (one extra capture per poll on the state path) and fall back to `ReadyByState` when that capture errors non-fatally | Hooks can fire on an unauthenticated boot, so the state path must see the screen; a transient capture failure must not regress a state-proven pane | S:75 R:85 A:80 D:75 |
| 3 | Certain | Snippet is the wall text itself, not the trailing 120 runes | The trailing runes of a Claude screen are the composer/footer, which hide why the pane is parked | S:85 R:90 A:90 D:90 |
| 4 | Confident | Ship the login-wall check as a best-effort safety net and document its timing limit, rather than delaying ready verdicts until the notice could have painted | Measured: notice paints 2–20 s after boot, after the hooks stamp state; holding every verdict ~20 s would slow every spawn for a rare failure whose root cause R2 fixes. The check costs one capture per poll and has no false positives in the matcher tests | S:70 R:85 A:75 D:65 |
| 5 | Certain | Strip ANSI escapes (`ansiEscapeRe`, already in the package) before matching | Found at apply: readiness captures use `capture-pane -e`; the live check failed until stripped | S:95 R:95 A:95 D:95 |

5 assumptions (2 certain, 3 confident, 0 tentative).
