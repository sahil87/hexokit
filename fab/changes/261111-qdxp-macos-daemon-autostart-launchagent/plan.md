# Plan: macOS daemon autostart (LaunchAgent)

**Change**: 261111-qdxp-macos-daemon-autostart-launchagent
**Intake**: `intake.md`

## Requirements

The shared surface (`autostart.go`, `cmd/rk/daemon_autostart.go`, `ErrAlreadyRunning` + `--if-not-running`, the memory skeleton) already landed at intake as commit `e7336e55`. These requirements cover the macOS backend only. Shared files MUST NOT change without agreement with the A1 lane.

### Autostart: launchd backend

#### R1: Registration and identity
The launchd backend SHALL register for GOOS `darwin` from `init()` via `autostart.Register` and SHALL use label `ai.shll.hexokit.daemon`, plist path `~/Library/LaunchAgents/ai.shll.hexokit.daemon.plist`, and service target `gui/<uid>/ai.shll.hexokit.daemon`.

- **GIVEN** the `autostart` package is linked
- **WHEN** `autostart.For("darwin")` is called
- **THEN** it returns the launchd backend with no build-tag dependency (it works on a Linux host)

#### R2: Plist shape
The rendered plist MUST carry the `ManagedMarker` comment, `Label`, and `ProgramArguments` = `[<login shell>, "-lc", StartScript(<stable rk path>, nil)]`. `RunAtLoad` true, `AbandonProcessGroup` true, and `StandardOutPath`/`StandardErrorPath` = `<state home>/logs/autostart.log`. It MUST NOT contain `KeepAlive`. Every string MUST be XML-escaped.

- **GIVEN** rk at `/opt/homebrew/bin/hexokit` and login shell `/bin/zsh`
- **WHEN** the plist is rendered
- **THEN** it is a valid XML plist with those keys and values, and `exec '/opt/homebrew/bin/hexokit' daemon start --if-not-running` as the third argument
- **AND** a path containing `&`, `<` or `'` is escaped so the document still parses

#### R3: Login shell lookup
The backend SHALL resolve the user's login shell with `dscl . -read /Users/<user> UserShell`, not from `$SHELL`. It falls back to `/bin/zsh` when dscl fails or returns no absolute path.

- **GIVEN** dscl prints `UserShell: /opt/homebrew/bin/fish`
- **WHEN** the shell is resolved
- **THEN** it is `/opt/homebrew/bin/fish`. A failing dscl gives `/bin/zsh`

#### R4: `on [--now]`
`On` SHALL write the plist atomically (mode 0644, creating `~/Library/LaunchAgents` and the logs dir), and rewrite it only when the content differs. It SHALL run `launchctl enable gui/<uid>/<label>`. Without `Now` it MUST NOT bootstrap. With `Now`: a job that is not loaded is bootstrapped (`RunAtLoad` runs it); a loaded job with a changed plist is booted out and then bootstrapped; a loaded, unchanged job is re-run with `launchctl kickstart gui/<uid>/<label>`. `Result.Changed` reports whether the plist was written; `Result.Started` is true whenever `Now` ran successfully.

- **GIVEN** no plist
- **WHEN** `On(Now=false)`
- **THEN** the plist is written, `enable` runs, no `bootstrap` runs, and `Changed=true, Started=false`
- **GIVEN** an identical plist already loaded
- **WHEN** `On(Now=true)`
- **THEN** nothing is written, `kickstart` runs, and `Changed=false, Started=true`
- **GIVEN** a changed plist on a loaded job
- **WHEN** `On(Now=true)`
- **THEN** `bootout` runs before `bootstrap gui/<uid> <plist>` and `Started=true`

#### R5: `off`
`Off` MUST refuse to touch a plist at the path that lacks `ManagedMarker`. Otherwise it bootouts if the job is loaded and deletes the plist. It is idempotent (`Changed=false` when nothing was there) and MUST NOT stop the daemon.

- **GIVEN** a foreign plist at the path
- **WHEN** `Off`
- **THEN** it returns an error and the file remains
- **GIVEN** no plist and the job not loaded
- **WHEN** `Off`
- **THEN** it succeeds with `Changed=false` and issues no `bootout`

#### R6: `status`
`Status` SHALL report `platform: darwin` and `manager: launchd`, plus name, path, `registered` (the plist exists), `enabled` (registered and not listed disabled in `launchctl print-disabled gui/<uid>`), `starts_at: login` when registered, `linger` nil, `last_exit_code`/`last_result` parsed from `launchctl print` (`last exit code = N`; `(never exited)` → nil / `never run`; not loaded → nil / `not loaded`), `rk_path`, `shell`, and `stale` (on-disk ≠ rendering). Hints: `.zshrc` vs `.zprofile` when registered, a refresh hint when stale, and the turn-on command when not registered.

- **GIVEN** a loaded, current plist and `last exit code = 0`
- **WHEN** `Status`
- **THEN** `registered`, `enabled`, `starts_at=login`, `last_exit_code=0`, `last_result=success`, `stale=false`
- **GIVEN** `"ai.shll.hexokit.daemon" => disabled` in print-disabled
- **THEN** `enabled=false`

#### R7: Process execution
Every `launchctl`/`dscl` invocation MUST use `exec.CommandContext` with a timeout and an argument slice, behind one `runCmd` seam. Tests MUST NOT reach a real service manager.

- **GIVEN** the test suite
- **WHEN** any backend method runs
- **THEN** only the fake `runCmd` is called and files land under `t.TempDir()`

### Non-Goals
- Changing the desktop app (CLI-only by intake decision).
- Verifying on a real Mac. That is deferred to A5, and the PR states it.
- Editing shared files (`autostart.go`, `cmd/rk/daemon_autostart.go`).

### Design Decisions

#### Bootstrap only with --now
**Decision**: `on` writes and enables the plist. Only `on --now` runs `launchctl bootstrap`.
**Why**: With `RunAtLoad`, bootstrap runs the job immediately, so an unconditional bootstrap would start the daemon on every `on`. launchd loads `~/Library/LaunchAgents` at login anyway.
**Rejected**: Bootstrapping on every `on`, as the plan brief literally says. It contradicts the agreed "register only unless `--now`".
*Introduced by*: 261111-qdxp-macos-daemon-autostart-launchagent

#### Plist rendered by hand, not via a plist library
**Decision**: Render the plist with a fixed text template plus `encoding/xml` escaping.
**Why**: Six keys in a fixed shape. No new module dependency, and the output is byte-stable, which makes `stale` detection a plain byte comparison.
**Rejected**: A third-party plist encoder. It adds a dependency and its formatting could change across versions, causing false `stale` results.
*Introduced by*: 261111-qdxp-macos-daemon-autostart-launchagent

## Tasks

### Phase 2: Core Implementation

- [x] T001 Create `app/backend/internal/daemon/autostart/launchd.go`: constants (label, rel path, `starts_at`), the seam struct (runCmd, homeDir, uid, username, loginShell via dscl with fallback, rkPath, logsDir, readFile/writeFile), `init()` registration, and plist rendering with XML escaping <!-- R1 R2 R3 R7 -->
- [x] T002 Implement `On`, `Off` and `Status` in `launchd.go`: plist write/compare, enable, `--now` bootout/bootstrap, the marker-guarded delete, `print`/`print-disabled` parsing, and hints <!-- R4 R5 R6 -->
- [x] T003 Create `app/backend/internal/daemon/autostart/launchd_test.go` covering R1–R7 with a recording fake `runCmd` and `t.TempDir()` homes <!-- R1 R2 R3 R4 R5 R6 R7 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Run `just test-backend` and confirm the autostart and cmd/rk autostart tests pass; `gofmt`/`go vet` clean <!-- R7 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `For("darwin")` returns the launchd backend on a Linux host, with label/path/target as specified
- [x] A-002 R2: the rendered plist has the marker, Label, ProgramArguments (shell, `-lc`, StartScript), RunAtLoad, AbandonProcessGroup and log paths, and no KeepAlive
- [x] A-003 R3: the dscl-resolved shell is used; the fallback is `/bin/zsh`; `$SHELL` is never read
- [x] A-004 R4: `On` without Now never bootstraps; `On` with Now bootstraps (bootout first when loaded and changed); an identical, loaded plist is not rewritten and is re-run via kickstart
- [x] A-005 R5: `Off` bootouts if loaded and deletes the plist, never stops the daemon, and refuses a foreign plist
- [x] A-006 R6: `Status` fields and hints match R6, including disabled, never-exited and not-loaded parsing

### Scenario Coverage

- [x] A-007 R4: tests assert the exact launchctl argv sequence for on, on --now (fresh → bootstrap / unchanged-loaded → kickstart / changed-loaded → bootout+bootstrap)
- [x] A-008 R6: tests cover last-exit parsing for `0`, a non-zero code, `(never exited)` and not loaded

### Edge Cases & Error Handling

- [x] A-009 R2: a path with XML-special characters renders a parseable plist
- [x] A-010 R4: a launchctl failure (bootstrap non-zero) surfaces as an error naming the command and its output
- [x] A-011 R5: `Off` on an absent registration is `Changed=false` with no launchctl mutation

### Code Quality

- [x] A-012 Pattern consistency: seams follow the package-level/injected seam idiom of `internal/daemon` (e.g. `jobRunTmux`)
- [x] A-013 No unnecessary duplication: reuses `fsatomic`, `apphome.LogsDir`, `autostart.RKPath`/`StartScript`/`ManagedMarker`
- [x] A-014: all subprocesses use `exec.CommandContext` with a timeout and argument slices (Principle I)
- [x] A-015: no comment narration; comments state constraints only
- [x] A-016: shared files unchanged relative to `e7336e55`

### Security

- [x] A-017 R7: no shell strings are built for launchctl/dscl; the label is a constant and the username is passed as one argv element

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant. (`internal/remote/ssh.go:207` still matches the `daemon already running` text, but it parses remote SSH output, where `errors.Is` cannot reach, so it stays.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Username for dscl from `os/user.Current()` behind a seam | Standard library; dscl keys on the short name | S:70 R:90 A:80 D:80 |
| 2 | Confident | `launchctl print` exit status non-zero ⇒ not loaded; a missing `last exit code` line ⇒ nil code / empty result | launchctl prints "Could not find service" with a non-zero exit when the service is unknown | S:60 R:90 A:65 D:70 |
| 3 | Confident | Disabled detection matches the line `"<label>" => disabled` or `=> true` in `print-disabled` | macOS 13+ prints `disabled`, older versions print `true` | S:60 R:90 A:65 D:70 |
| 5 | Confident | `on --now` on a loaded, unchanged job uses `kickstart` (no `-k`) | `--now` promises a start attempt; bootstrap would fail on an already-loaded job, and kickstart without `-k` never kills a running instance | S:65 R:90 A:65 D:70 |
| 4 | Confident | A failed launchctl call returns an error carrying the argv and combined output | Matches error style elsewhere in `internal/daemon` | S:70 R:90 A:80 D:80 |

5 assumptions (0 certain, 5 confident, 0 tentative).
