# Plan: Hook Launcher — Agent-State Writes Survive the Brew Upgrade Window

**Change**: 260916-la8z-hook-launcher-upgrade-window
**Intake**: `intake.md`

## Requirements

### selfpath: the launcher resolver

#### R1: `internal/selfpath` owns the rk launcher path
`internal/selfpath` MUST expose a third resolver audience beside `Resolve` and `Stable`: `LauncherRelDir` (`".local/share/rk/bin"`), `LauncherFor(home string) string` (`<home>/.local/share/rk/bin/run-kit`), and `Launcher() (string, error)` (`LauncherFor(os.UserHomeDir())`). The package doc MUST describe the three audiences and state why the launcher survives the `brew upgrade` window (its target is the Cellar binary, which Homebrew deletes only in cleanup, after the new keg is linked). `cmd/rk`'s `rkBinRelDir` / `rkBinDir` MUST resolve through the selfpath constant so the gui display block's shell literal and the Go path can never disagree.

- **GIVEN** a home directory `/home/u`
- **WHEN** `selfpath.LauncherFor("/home/u")` is called
- **THEN** it returns `/home/u/.local/share/rk/bin/run-kit`
- **AND** `cmd/rk`'s `guiPointerPath("/home/u")` returns the identical string

#### R2: atomic symlink replacement lives beside the resolver
`replaceSymlink` (temp symlink in the same dir + rename, stale `.run-kit.tmp-*` sweep) MUST move to `internal/selfpath` as `ReplaceSymlink(target, linkPath string) error` so both the installer and the daemon share one implementation. `cmd/rk` MAY keep a thin alias.

- **GIVEN** an existing symlink at `linkPath` with target A
- **WHEN** `ReplaceSymlink(B, linkPath)` runs
- **THEN** the path is a symlink to B and no `.run-kit.tmp-*` file remains in its directory
- **AND** at no instant during the call is `linkPath` absent

### rk agent setup: launcher pointer + two-path wrapper

#### R3: the launcher pointer is a hooks-family artifact written before the hooks
`rk agent setup` MUST write the launcher symlink as a first step, ahead of every per-agent hook install, the tmux guard shim, and the gui display block, reusing the existing pointer flow (`installGuiDisplayPointer`: probe → consent → `MkdirAll` after consent → re-probe → atomic replace; foreign non-symlink left untouched; already-current no-op; relink on other target). Its target MUST be `filepath.EvalSymlinks(rkPath)` of the validated PATH-found stable path (falling back to `rkPath` unchanged when it does not resolve) — never the running setup binary's `selfpath.Resolve()`. Messages use the prefix `launcher:` instead of `gui display:`. The gui display block MUST keep gating on the pointer verdict (`InPlace` / `Foreign` / `Declined`) without re-running the pointer step. `--uninstall` MUST remove the pointer last, after the hooks and the gui block. A declined pointer write MUST NOT block hook installation.

- **GIVEN** a Homebrew machine where `rkPath` is `/home/linuxbrew/.linuxbrew/bin/run-kit` → `../Cellar/run-kit/3.20.4/bin/run-kit`
- **WHEN** `rk agent setup --yes` runs
- **THEN** `~/.local/share/rk/bin/run-kit` is a symlink whose target is `/home/linuxbrew/.linuxbrew/Cellar/run-kit/3.20.4/bin/run-kit`
- **AND** the `launcher:` step's output precedes every per-agent hook line

- **GIVEN** a regular file at the pointer path
- **WHEN** `rk agent setup` runs
- **THEN** the file is untouched, the step reports it foreign, hooks are still installed with both paths, and any existing gui block is stripped

#### R4: every installed hook command carries the launcher first and the stable path second
`agentStateHookCommand(launcherPath, stablePath, state, provider)` MUST produce
`/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "<launcher>" agent hook --agent <p> <s> 2>/dev/null || "<stable>" agent hook --agent <p> <s> 2>/dev/null || true'`
and `agentStateHookCommandJSON` MUST produce
`/bin/sh -c '[ -n "$TMUX_PANE" ] && { "<launcher>" agent hook --agent <p> <s> 2>/dev/null || "<stable>" agent hook --agent <p> <s> 2>/dev/null; }; echo "{}"'`.
Both paths MUST pass `validateHookPath` before any file is written (an unvalidatable launcher path fails the install exactly as an unvalidatable stable path does). The copilot hooks file, the kimi TOML block (`command = "..."` via `tomlBasicString`), and the opencode plugin (`const RK = "<path>"` plus a second `const RK_FALLBACK = "<path>"` or equivalent, with the invocation trying both) MUST carry the same two-path fallback in their own syntax. No option name, state token, or write logic may appear in any wrapper. The ` agent hook ` family marker MUST still match so `isRkEntry` replaces gen-3 lines in place and `--uninstall` strips every generation. Existing installs keep working unchanged until the user re-runs `rk agent setup`.

- **GIVEN** the launcher dangles and the stable path is live
- **WHEN** a hook fires
- **THEN** the first exec fails with 127 (stderr discarded), the second runs `rk agent hook`, and the wrapper exits 0

- **GIVEN** both paths dangle
- **WHEN** a hook fires
- **THEN** the wrapper exits 0 (classic) or prints `{}` and exits 0 (JSON) with nothing on stderr

#### R5: `rk doctor` parses every embedded path and fails only when all dangle
`hookRkPath` MUST become a multi-path extractor (every double-quoted token immediately before each ` agent hook ` occurrence, and both consts of the opencode plugin via `extractRkHookCommands`). `checkHookRkPath` MUST fail only when every embedded path is not an existing regular executable. A dangling launcher with a live stable path MUST pass with a note (`launcher <path> dangling — re-run rk agent setup`); a dangling stable path with a live launcher MUST pass with a note. A gen-3 command carrying a single path MUST pass with a note that the launcher fallback is missing (`single-path wrapper — re-run rk agent setup to add the launcher fallback`). `classifyHookGeneration` stays at three generations.

- **GIVEN** an installed two-path command whose launcher target is missing
- **WHEN** `rk doctor` runs
- **THEN** the agent-hooks row is OK and carries the launcher note

### daemon: serve-time re-point

#### R6: `rk serve` re-points the launcher at start, on Homebrew daemons only
Immediately after `tmux.EnsureConfig()` in `cmd/rk/serve.go` RunE, and only when `resolveBrewInstalled()` is true, the daemon MUST Lstat `selfpath.Launcher()`: absent → nothing; non-symlink → `slog.Info` not rk-owned, nothing; symlink whose `Readlink` equals `selfpath.Resolve()` → nothing; symlink with any other target → `selfpath.ReplaceSymlink(resolved, launcher)` and `slog.Info` old → new. Every error is `slog.Warn`; startup never fails because of this step. The resolve/lstat/readlink/replace calls MUST sit behind package-var seams so tests never touch `$HOME`. A non-brew daemon (dev worktree, e2e rig, curl install) MUST NOT re-point.

- **GIVEN** a brew daemon at Cellar 3.20.4 and a launcher pointing at Cellar 3.20.3
- **WHEN** `rk serve` starts
- **THEN** the launcher points at the 3.20.4 binary and a log line records old → new

- **GIVEN** a non-brew daemon and a stale launcher
- **WHEN** `rk serve` starts
- **THEN** the launcher is unchanged

#### R7: code-server's `RK_BIN` is the launcher
`codeServerSelfPath` in `internal/daemon/codeserver.go` MUST resolve via `selfpath.Launcher` so the code-bridge extension's per-action `$RK_BIN` exec works during the upgrade window. `guiSelfPath` and the upgrade restart (`StableFor`) MUST stay on `Stable`. The doc comment is rewritten for the new audience.

- **GIVEN** the daemon spawns `rk-code-server`
- **WHEN** the argv is captured through the test seam
- **THEN** the `env` prefix carries `RK_BIN=<home>/.local/share/rk/bin/run-kit`

### agent state: `active` age on machine surfaces

#### R8: the duration is emitted for `active` too
`rk mux panes` (`agent_state_duration`), `rk mux capture` (`agent_state_duration`), and the window rollup (`rollupAgentState` → `AgentIdleDuration`) MUST compute the duration for any known state with `epoch > 0`, not only `idle`/`waiting`. Field names are unchanged. Comments MUST state the new rule and its reason (a lost write on a live agent is otherwise invisible).

- **GIVEN** a pane whose option reads `active:<now-720>:<pid>` with the pid alive
- **WHEN** `rk mux panes --json` runs
- **THEN** the row carries `"agent_state": "active", "agent_state_duration": "12m"`

#### R9: the SPA renders durations only for `waiting`/`idle`
`src/components/sidebar/registers.ts` `getAgentLine`, `src/components/status-dot-label.ts` `dotLabel`, and `src/components/quake-terminal.tsx`'s agent-idle read MUST gate the duration on `agentState === "waiting" || agentState === "idle"` so rendered output is byte-identical to today for every state. The `src/types.ts` comment on `agentIdleDuration` and the `status-dot-label.ts` comment MUST say the field is populated for `active` too but rendered only for the two rest states. One Vitest case per gated consumer MUST assert an `active` window with a duration renders without it.

- **GIVEN** a window with `agentState: "active"` and `agentIdleDuration: "12m"`
- **WHEN** `getAgentLine` runs
- **THEN** it returns `active`

### spec

#### R10: the agent-state spec records the two-path wrapper and the live-idle caveat
`docs/specs/agent-state.md` Writer rule 4 MUST gain the live-idle-agent caveat (a lost `idle` on a live agent is stale indefinitely, which is why the wrapper carries two paths) and describe the launcher; the canonical command block MUST show the two-path shape with `<launcher>` and `<stable>` placeholders.

- **GIVEN** the spec after this change
- **WHEN** a reader looks up the hook command shape
- **THEN** they see both paths and the reason for the second

### Non-Goals
- Demoting a stale `active` to unknown after a timeout — rejected in the intake.
- A post-upgrade sweep clearing `active` values from `rk update` — rejected.
- Any inline `tmux set-option` or retry-with-sleep in the wrapper — rejected.
- The tmux-upgrade window for the `tmux` exec inside `rk agent hook` — recorded as a residual gap for hydrate, not fixed here.
- Memory updates — hydrate's job (see intake § Affected Memory).

### Design Decisions

#### Two paths in the wrapper, each covering the other's hole
**Decision**: the hook wrapper execs the rk-owned launcher (Cellar-targeted) first and the brew stable symlink second.
**Why**: Homebrew unlinks the stable symlink before the network-bound install phase and relinks in `finish`, but deletes the old keg only in cleanup after link; the launcher is live exactly when the stable symlink is not, and the stable symlink covers the moment after cleanup before the daemon re-points.
**Rejected**: inline `tmux set-option` fallback (re-freezes option name/format into settings.json); retry-with-sleep (covers seconds, not minutes); Cellar path pinned at install (re-freezes the hook).
*Introduced by*: 260916-la8z-hook-launcher-upgrade-window

#### The daemon start is the re-point trigger, gated on a brew daemon
**Decision**: `rk serve` re-points the launcher when the daemon binary carries the Cellar marker; no timer, no watcher, no `rk update` hook.
**Why**: the same posture as the managed tmux.conf refresh; `rk update` restarts the daemon seconds after the upgrade, and a dev-worktree or e2e-rig daemon must never re-point the machine's hooks at a throwaway build.
**Rejected**: an unconditional re-point (dev/e2e hazard); re-pointing from `rk update` (misses manual `brew upgrade`).
*Introduced by*: 260916-la8z-hook-launcher-upgrade-window

#### Install-time target resolves the PATH-found stable symlink
**Decision**: the launcher's target at install time is `filepath.EvalSymlinks(rkPath)`, not the running setup binary.
**Why**: `bin/rk agent setup` from a dev worktree is routine here; today's `resolveRkPath` deliberately does not trust the running binary's location.
**Rejected**: `selfpath.Resolve()` of the setup binary (points the machine's hooks at a dev build).
*Introduced by*: 260916-la8z-hook-launcher-upgrade-window

## Tasks

### Phase 1: Setup

- [x] T001 Add `LauncherRelDir`, `LauncherFor`, `Launcher`, and `ReplaceSymlink` to `app/backend/internal/selfpath/selfpath.go` (move `replaceSymlink` from `cmd/rk/agent_setup.go`), extend the package doc to three audiences, and add unit tests in `selfpath_test.go` (LauncherFor path, ReplaceSymlink atomicity + stale-temp sweep in a temp dir) <!-- R1, R2 -->
- [x] T002 [P] Make `rkBinRelDir` / `rkBinDir` in `app/backend/cmd/rk/tmux_guard.go` resolve through `selfpath.LauncherRelDir` / `selfpath.LauncherFor`, and point `guiPointerPath` / `guiPointerShellPath` in `cmd/rk/agent_setup.go` at them; `cmd/rk` callers of `replaceSymlink` use `selfpath.ReplaceSymlink` <!-- R1 -->

### Phase 2: Core Implementation

- [x] T003 Change `agentStateHookCommand` and `agentStateHookCommandJSON` in `app/backend/cmd/rk/agent_setup.go` to the two-path shape (launcher first, stable second), update every call site (JSON hooks merge at ~line 1089, `copilotHooksFile`, `kimiHooksBlock`, `opencodePluginFile` — the plugin gains a second const and an invocation that tries both), apply `validateHookPath` to both paths in `runAgentSetup`, and extend `TestAgentStateHookCommandShape` (`agent_setup_test.go`) and `TestAgentStateHookCommandJSONShape` (`agent_hook_test.go`) to assert both paths, the `|| true` / `echo "{}"` tail, and marker matching <!-- R4 -->
- [x] T004 In `app/backend/cmd/rk/agent_setup.go` `runAgentSetup`, add a launcher step that runs first: compute the target as `filepath.EvalSymlinks(rkPath)` (fallback `rkPath`), call the pointer flow (rename `installGuiDisplayPointer` → `installLauncherPointer`, message prefix `launcher:`), pass its verdict into `applyGuiDisplayBlocks` instead of re-running the pointer step there, keep hooks installing on a declined pointer, and order `--uninstall` as hooks → gui block → pointer; adapt `TestGuiDisplayPointerRelink` and the setup ordering tests <!-- R3 -->
- [x] T005 Rewrite `hookRkPath` in `app/backend/cmd/rk/doctor.go` as `hookRkPaths(cmd) []string`, teach `extractRkHookCommands` the opencode second const, and change `checkHookRkPath` to the all-dangle failure rule with the launcher-dangling, stable-dangling, and single-path notes; add doctor tests for both wrapper variants and the three note cases <!-- R5 -->
- [x] T006 Add the launcher re-point to `app/backend/cmd/rk/serve.go` RunE after `tmux.EnsureConfig()`, gated on `resolveBrewInstalled()`, behind package-var seams (resolve / lstat / readlink / replace), never fatal; unit-test absent, foreign, current, stale, and non-brew cases <!-- R6 -->
- [x] T007 [P] Switch `codeServerSelfPath` in `app/backend/internal/daemon/codeserver.go` to `selfpath.Launcher`, rewrite its doc comment, and update the spawn-argv test to assert the launcher `RK_BIN`; leave `guiSelfPath` and `upgrade.go` on `Stable` <!-- R7 -->

### Phase 3: Integration & Edge Cases

- [x] T008 [P] Emit the duration for `active` in `app/backend/cmd/rk/mux_panes.go`, `cmd/rk/mux_capture.go`, and `internal/sessions/sessions.go` `rollupAgentState` (condition: known state and `epoch > 0`), rewrite the "active has no duration" comments, and add tests for an aged `active` value at all three sites <!-- R8 -->
- [x] T009 [P] Gate the duration on `waiting`/`idle` in `app/frontend/src/components/sidebar/registers.ts` `getAgentLine`, `src/components/status-dot-label.ts` `dotLabel`, and `src/components/quake-terminal.tsx`; fix the `src/types.ts` and `status-dot-label.ts` comments; add one Vitest case per consumer for an `active` window with a duration <!-- R9 -->
- [x] T010 Run the gates: `just _ensure-tmux-conf` then `just test-backend` (use `env -u TMUX -u TMUX_PANE` if a test reaches `checkPreconditions`), and `just test-frontend` (full run); regenerate any installer fixture files for the two-path shape and fix failures <!-- R3, R4, R8, R9 -->

### Phase 4: Polish

- [x] T011 Update `docs/specs/agent-state.md` Writer rule 4 and the canonical command block for the two-path wrapper, the launcher, and the live-idle-agent caveat <!-- R10 -->
- [x] T012 [P] Check the changed `rk agent setup` / `rk doctor` output text against `shll standards principles` (and `shll standards help-dump` only if any help text changed); no new flags or subcommands are introduced <!-- R3, R5 -->

## Execution Order

- T001 blocks T002, T004, T006, T007
- T003 blocks T004 and T005 (doctor parses the new shape)
- T010 runs after every code task; T011/T012 are independent of it

## Acceptance

### Functional Completeness

- [x] A-001 R1: `selfpath.LauncherFor`, `Launcher`, and `LauncherRelDir` exist, are unit-tested, and `cmd/rk`'s pointer path derives from them
- [x] A-002 R2: `selfpath.ReplaceSymlink` is the single atomic-replace implementation used by both the installer and the daemon
- [x] A-003 R3: `rk agent setup` writes the launcher first, targeting `EvalSymlinks(rkPath)`, with `launcher:` messages, and the gui block gates on its verdict
- [x] A-004 R4: every installer kind (JSON hooks merge, copilot file, kimi TOML block, opencode plugin) emits the two-path shape with both paths validated
- [x] A-005 R5: `rk doctor` extracts every embedded path and applies the all-dangle failure rule with the three notes
- [x] A-006 R6: `rk serve` re-points a stale launcher on a brew daemon and leaves it alone on a non-brew daemon
- [x] A-007 R7: code-server spawn argv carries `RK_BIN=<launcher>`; gui and upgrade restart remain on `Stable`
- [x] A-008 R8: `agent_state_duration` / `AgentIdleDuration` are populated for `active`
- [x] A-009 R9: the three SPA consumers render no duration for `active`
- [x] A-010 R10: the spec shows the two-path command and the live-idle caveat

### Behavioral Correctness

- [x] A-011 R4: the classic wrapper still exits 0 and the JSON wrapper still ends with `echo "{}"` when both paths dangle; the `||` chain advances only on exec failure
- [x] A-012 R3: a declined or foreign pointer never blocks hook installation; `--uninstall` removes the pointer after the hooks and gui block
- [x] A-013 R6: the re-point never creates a missing launcher and never touches a non-symlink

### Scenario Coverage

- [x] A-014 R4: a test asserts the wrapper string for both variants contains the launcher path before the stable path and the ` agent hook ` marker
- [x] A-015 R6: tests cover absent / foreign / current / stale / non-brew for the serve re-point through seams (no real `$HOME` symlinks)
- [x] A-016 R8: tests cover an aged `active` value in `rk mux panes`, `rk mux capture`, and `rollupAgentState`
- [x] A-017 R9: Vitest covers an `active` window with a duration for each gated consumer

### Edge Cases & Error Handling

- [x] A-018 R3: `EvalSymlinks` failure falls back to `rkPath` unchanged and the install proceeds
- [x] A-019 R4: an unvalidatable launcher path fails the install loudly before any file is written
- [x] A-020 R5: a single-path gen-3 command passes doctor with the re-run note

### Code Quality

- [x] A-021 Pattern consistency: new seams follow the `codeServerSelfPath` package-var style; new tests are colocated `*_test.go` / `*.test.ts`
- [x] A-022 No unnecessary duplication: one `ReplaceSymlink`, one launcher path constant, one pointer flow
- [x] A-023 Subprocess safety: no shell strings in Go; every exec stays `exec.CommandContext` with argv slices
- [x] A-024 Comments state constraints, not narration; no change IDs or PR numbers in code comments
- [x] A-025 Gates: `just test-backend` and `just test-frontend` pass in full

### Security

- [x] A-026 R4: both embedded paths reject `' " $ \` \\` via `validateHookPath` before being interpolated into the single-quoted `sh -c` body

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None remaining — the only redundancies this change created were deleted in the same diff: `cmd/rk`'s `replaceSymlink` (moved to `internal/selfpath.ReplaceSymlink`, the single implementation both the installer and the daemon now share) and doctor's single-path extractor `hookRkPath` (superseded by the multi-path `hookRkPaths`). No other existing code was made redundant.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The opencode plugin carries the fallback as a second const plus an invocation that tries both, rather than a single shell string | Mechanical port of the two-path rule into JS; the intake leaves the exact syntax to apply | S:70 R:85 A:80 D:70 |
| 2 | Confident | The three doctor note strings are as written in R5; wording may be tuned against `shll standards principles` in T012 | Intake gives the intent and example text; exact wording is low-stakes | S:65 R:90 A:80 D:75 |
| 3 | Certain | The spec edit is an apply task (T011); memory edits are hydrate's | Specs are listed under the intake's What Changes § 6; memory under Affected Memory | S:90 R:90 A:95 D:95 |
| 4 | Confident | `installGuiDisplayPointer` is renamed to `installLauncherPointer` and its verdict type keeps the three states | The intake says reuse the flow verbatim with a new prefix; a rename keeps the name honest | S:70 R:90 A:85 D:80 |
| 5 | Confident | The stable-path-dangling doctor note mirrors the launcher one verbatim with `stable path` substituted (`stable path <path> dangling — re-run `rk agent setup``); notes surface on the passing OK row appended as ` — <Agent>: <note>; …` | R5 specifies only the launcher-dangling text; symmetric wording keeps the remediation identical and the check's existing note channel carries it | S:60 R:90 A:80 D:70 |
| 6 | Confident | The `launcher:` prefix applies to the whole pointer flow — `guiPointerProbe` error wraps and the uninstall removal messages (`removeGuiDisplayPointer` → `removeLauncherPointer`), not only the install step | The pointer is now a launcher artifact end to end; a half-renamed message stream would misattribute failures to the gui display block | S:65 R:90 A:85 D:75 |
| 7 | Certain | The opencode plugin's fallback triggers ONLY on spawn-level exec failure (the child `error` event, e.g. ENOENT mid-upgrade) — a spawned process that exits non-zero never retries, matching the shell wrapper's `||` semantics (`rk agent hook` always exits 0) | R4's "advances only on exec failure" invariant applied to the JS port; node reports exec failure via the error event, so that is the exact equivalent signal | S:80 R:90 A:90 D:85 |

7 assumptions (2 certain, 5 confident, 0 tentative).
