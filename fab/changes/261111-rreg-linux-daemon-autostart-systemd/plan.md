# Plan: Linux daemon autostart (systemd user unit)

**Change**: 261111-rreg-linux-daemon-autostart-systemd
**Intake**: `intake.md`

## Requirements

### CLI: `rk daemon autostart` (shared surface, co-owned with A2)

#### R1: Shared surface integrated byte-identical with A2
The shared files (`app/backend/internal/daemon/autostart/autostart.go` + `autostart_test.go`, `app/backend/cmd/rk/daemon_autostart.go`, the `daemon.go` AddCommand + help line, `--if-not-running` in `daemon_start.go`, `daemon.ErrAlreadyRunning`, the `docs/memory/run-kit/daemon-autostart.md` skeleton) SHALL be the A2-authored commit on `origin/autostart-shared`, cherry-picked unchanged. A1 SHALL NOT edit a shared file without first agreeing the change with A2 by message. If the commit has not landed when apply needs it, A1 MAY author it to the agreed contract and MUST send A2 the sha.

- **GIVEN** A2 pushed the shared commit to `origin/autostart-shared`
- **WHEN** A1 integrates it
- **THEN** `git cherry-pick <sha>` applies cleanly and the A1 branch carries it unmodified
- **AND** every A1-only change lives in `systemd.go` / `systemd_test.go` (plus fab/docs artifacts)

#### R2: Idempotent start
`rk daemon start --if-not-running` SHALL exit 0 when the daemon is already running and SHALL fail exactly as `rk daemon start` for every other error (shared commit; A1 verifies).

- **GIVEN** the daemon is running
- **WHEN** `rk daemon start --if-not-running` runs
- **THEN** it exits 0 and reports that the daemon is already running
- **AND** without the flag it still exits non-zero with `daemon already running`

### Linux backend: systemd user unit (`internal/daemon/autostart/systemd.go`)

#### R3: Registration
The Linux backend SHALL self-register for GOOS `linux` in `init()` and SHALL NOT use build tags, so its tests run on every CI OS.

- **GIVEN** the binary runs on Linux
- **WHEN** `autostart.For("linux")` is called
- **THEN** it returns the systemd backend

#### R4: Unit file content (S1 L7)
The rendered unit at `<UserConfigDir>/systemd/user/hexokit-daemon.service` SHALL be: a first-line comment containing `ManagedMarker`; `[Unit] Description=HexoKit daemon (started once at boot/login, not supervised)`; `[Service] Type=oneshot`, `RemainAfterExit=yes`, `KillMode=process`, `TimeoutStartSec=90`, and `ExecStart=<login shell> -lc "<StartScript(rkPath, systemdInjectedEnv)>"`; `[Install] WantedBy=default.target`. It MUST NOT contain a `Restart=` line. `systemdInjectedEnv` = `INVOCATION_ID JOURNAL_STREAM MANAGERPID SYSTEMD_EXEC_PID MEMORY_PRESSURE_WATCH MEMORY_PRESSURE_WRITE`.

- **GIVEN** login shell `/usr/bin/zsh` and rk path `/home/linuxbrew/.linuxbrew/bin/rk`
- **WHEN** the unit is rendered
- **THEN** it matches the golden text byte-for-byte and has no `Restart=`

#### R5: Safe quoting and path validation
The renderer SHALL escape, inside the double-quoted ExecStart argument and the shell path, `\` → `\\`, `"` → `\"`, `%` → `%%`, `$` → `$$`. The shell path and rk path MUST be absolute and contain no control characters (including newline); otherwise rendering fails with a clear error (Constitution I).

- **GIVEN** an rk path containing a space and a `%`
- **WHEN** the unit is rendered
- **THEN** the `%` is doubled and the path survives intact inside the shell-quoted script
- **AND** a relative path or a path containing `\n` is refused

#### R6: Login shell from passwd
The backend SHALL resolve the login shell with `getent passwd <user>` (field 7) via `exec.CommandContext` with a 5 s timeout, falling back to `$SHELL`, then `/bin/sh`. A shell that is not absolute, not executable, or whose basename is `nologin` or `false` SHALL make `on` fail with a clear error.

- **GIVEN** `getent` prints `sahil:x:1000:1000::/home/sahil:/usr/bin/zsh`
- **WHEN** the login shell is resolved
- **THEN** it is `/usr/bin/zsh`
- **AND** `/usr/sbin/nologin` is refused

#### R7: systemd presence check
`on`, `off` and `status` SHALL fail with `rk daemon autostart: systemd not found — on Linux, autostart needs a systemd user manager (systemctl --user)` when `systemctl` is not on PATH or `/run/systemd/system` does not exist.

- **GIVEN** a Linux box without systemd
- **WHEN** any verb runs
- **THEN** it returns that error and runs no subprocess

#### R8: `on` registers idempotently, starts only with `--now`
`on` SHALL refuse when a file at the unit path lacks `ManagedMarker`; write the unit atomically (`fsatomic.WriteFile`, 0644, parent dir 0755) only when its bytes differ; run `systemctl --user daemon-reload` only after a write; then `systemctl --user enable hexokit-daemon.service` (never `--now`, never `start`). With `Now`, it SHALL then run `systemctl --user restart hexokit-daemon.service` and set `Started`. `Changed` SHALL be true iff the file was written or the enable state flipped (`is-enabled` checked before). It SHALL return hints for lingering-off and the rc-file caveat.

- **GIVEN** no unit exists
- **WHEN** `on` runs
- **THEN** the file is written, then `daemon-reload` then `enable` run, with no `start`/`restart`, and `Changed:true`
- **AND** a second `on` writes nothing, skips `daemon-reload`, and returns `Changed:false`
- **AND** `on --now` additionally runs `restart` and returns `Started:true`

#### R9: `off` never stops the daemon
`off` SHALL return `Changed:false` when no unit file exists and the unit is not enabled; refuse to delete a file lacking `ManagedMarker`; otherwise run `systemctl --user disable hexokit-daemon.service` (no `--now`), remove the file, and run `systemctl --user daemon-reload`. It MUST NOT run `stop`, `kill`, or `disable --now`.

- **GIVEN** a managed unit is installed and enabled
- **WHEN** `off` runs
- **THEN** `disable`, file removal and `daemon-reload` happen and no `stop` is issued
- **AND** a second `off` is a no-op with `Changed:false`

#### R10: `status` reports registration, enablement, linger, last result, staleness
`status` SHALL report `Platform:"linux"`, `Manager:"systemd"`, `Name`, `Path`, `Registered` (file exists with marker), `Enabled` (`is-enabled` prints `enabled`; non-zero exit with `disabled`/`not-found` is data), `LastResult`/`LastExitCode` (from `systemctl --user show -p Result -p ExecMainStatus -p ActiveState -p SubState`; empty/nil when the unit never ran), `Linger` (`loginctl show-user <user> -p Linger --value`, nil on error plus a hint), `StartsAt` (`boot` = enabled ∧ linger yes; `login` = enabled ∧ linger no/unknown; `""` otherwise), `Shell`, `RKPath`, `Stale` (on-disk bytes differ from a fresh render), and `Hints` (the `loginctl enable-linger <user>` command when linger is off, the per-shell rc-file caveat including rc-only `TMUX_TMPDIR`, and — when `Stale` — a re-run-`on` hint, which is how a moved or deleted rk path surfaces). A failing `show`/`loginctl` SHALL degrade the field, not fail the verb.

- **GIVEN** the unit is enabled, linger is `no`, and the last run was a success
- **WHEN** `status` runs
- **THEN** `StartsAt` is `login`, `Linger` is false, `LastResult` is `success`, and the hints include `loginctl enable-linger <user>`

#### R11: Bounded subprocesses behind seams
Every subprocess SHALL go through `exec.CommandContext` with a timeout (10 s for systemctl, 5 s for loginctl/getent, 120 s for `restart` under `--now`). The runner, config dir, username, lookPath, sd_booted probe, rk path and login-shell lookups SHALL be injectable, so tests run no real systemctl/loginctl/getent and write only under a temp dir.

- **GIVEN** the test suite runs
- **WHEN** backend tests execute
- **THEN** a fake runner records the argv, and no real unit directory or systemd manager is touched

### Non-Goals

- `rk doctor` row and the UI status line (A3); `rk skill` and site docs (A4); the macOS backend and desktop-app switch (A2); enabling it on a real machine (A5).
- Restarting a crashed daemon. There is no supervision.

### Design Decisions

#### Unit name `hexokit-daemon.service`
**Decision**: Name the systemd user unit `hexokit-daemon.service`.
**Why**: `off` must find the unit forever. The product name (`hexokit` state/config homes, brew keg) is stable, while the binary name has drifted (rk ↔ run-kit). `rk-daemon` is already the tmux socket/session name, so reusing it would be ambiguous.
**Rejected**: `rk-daemon.service`, which collides in meaning with the tmux socket and session and is tied to the binary name.
*Introduced by*: 261111-rreg-linux-daemon-autostart-systemd

#### `--now` re-runs the oneshot with `restart`
**Decision**: `on` registers only; `--now` runs `systemctl --user restart`.
**Why**: A bare `start` on an already `active (exited)` RemainAfterExit unit is a no-op. `restart` re-runs ExecStart, and with `--if-not-running` and `KillMode=process` S1 verified it is a success that kills nothing when the daemon is up.
**Rejected**: `enable --now` / `start` (silently does nothing on an active unit); starting by default (side effects on `on`, and asymmetric with `off` never stopping).
*Introduced by*: 261111-rreg-linux-daemon-autostart-systemd

#### Idempotent start flag over L7's status grep
**Decision**: ExecStart runs `rk daemon start --if-not-running`.
**Why**: S1's L7 matched `rk daemon status` display text with grep. The flag keeps L7's semantics (success when up, failure when rk is missing) without depending on output text.
**Rejected**: L7 verbatim (couples the unit to display text); L6 `ExecStart=-` (hides real failures).
*Introduced by*: 261111-rreg-linux-daemon-autostart-systemd

## Tasks

### Phase 1: Setup

- [x] T001 Integrate A2's shared commit from `origin/autostart-shared` (cherry-pick, unmodified); confirm it carries `daemon.ErrAlreadyRunning`, `rk daemon start --if-not-running`, `StartScript(rkPath, unsetEnv)`, `Status` (incl. `RKPath`/`Shell`/`Stale`/`Linger *bool`), `Result`, `ManagedMarker`, `Register`/`For`, `--json` on all three verbs, `--now` default false, and the memory skeleton. Raise any gap with A2 by message, never by local edit <!-- R1 R2 -->

### Phase 2: Core Implementation

- [x] T002 Write `app/backend/internal/daemon/autostart/systemd.go`: the `systemd` backend struct with seams (runner, configDir, username, lookPath, sdBooted, rkPath, loginShell), `init()` registration for `linux`, the pure `renderUnit(shell, rkPath)` with systemd escaping and path validation, the `getent`-based login-shell lookup with fallbacks and nologin/false refusal, and the systemd presence check <!-- R3 R4 R5 R6 R7 R11 -->
- [x] T003 In `systemd.go`, implement `On` (marker guard, compare-then-atomic-write, `daemon-reload` after a write, `enable`, `restart` on `Now`, Changed/Started/Hints), `Off` (no-op detection, marker guard, `disable` + remove + `daemon-reload`, never `stop`), and `Status` (`is-enabled`, `show` parsing, `loginctl` linger, StartsAt, Stale, Hints including the per-shell rc caveat and missing-rk-path) <!-- R8 R9 R10 R11 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Write `app/backend/internal/daemon/autostart/systemd_test.go` with a fake runner and temp config dir: golden unit (no `Restart=`); escaping of space, `%`, `$`, `"`; refusal of relative/control-character paths; login-shell parse, fallbacks and nologin refusal; no-systemd error with zero subprocesses; `on` first run, re-run no-op, `--now` restart, foreign-file refusal; `off` sequence without `stop`, re-run no-op, foreign-file refusal; `status` matrix (enabled/disabled/not-found, linger yes/no/error, Result success/exit-code/never-ran, Stale, StartsAt) <!-- R3 R4 R5 R6 R7 R8 R9 R10 R11 -->
- [x] T005 Verify: `just test-backend` green; `go vet ./...` and cross-builds `GOOS=darwin` / `GOOS=windows go build ./cmd/rk` compile (no build-tag leaks); render the unit for this machine to stdout via a throwaway Go test helper, without registering, enabling or touching the live daemon; check `rk daemon autostart --help` output against `shll standards` (help-dump) <!-- R1 R2 R3 R4 -->

## Acceptance

### Functional Completeness

- [ ] A-001 R1: The shared commit is cherry-picked unmodified from `origin/autostart-shared` (or authored to contract with the sha sent to A2), and no shared file differs from A2's copy
- [ ] A-002 R2: `rk daemon start --if-not-running` exits 0 when the daemon is running; other failures still exit non-zero
- [ ] A-003 R3: `systemd.go` registers for `linux` in `init()` and has no build tag
- [ ] A-004 R4: The rendered unit matches the L7 golden (oneshot, RemainAfterExit=yes, KillMode=process, TimeoutStartSec=90, login-shell `-lc` ExecStart with the env strip and `--if-not-running`, WantedBy=default.target, marker comment) and contains no `Restart=`
- [ ] A-005 R6: The login shell comes from `getent passwd` field 7 with the `$SHELL` → `/bin/sh` fallbacks
- [ ] A-006 R8: `on` writes + `daemon-reload` + `enable`, starts only with `--now` (via `restart`)
- [ ] A-007 R9: `off` runs `disable` + remove + `daemon-reload` and never `stop`
- [ ] A-008 R10: `status` populates every `Status` field listed in R10

### Behavioral Correctness

- [ ] A-009 R8: Re-running `on` with an identical unit is a no-op (`Changed:false`, no write, no `daemon-reload`)
- [ ] A-010 R9: Re-running `off` after removal is a no-op (`Changed:false`)

### Scenario Coverage

- [ ] A-011 R10: Tests cover the StartsAt matrix (boot / login / login-with-unknown-linger / off) and Stale detection
- [ ] A-012 R8: A test asserts the exact argv sequence for `on`, `on --now`, and `off`

### Edge Cases & Error Handling

- [ ] A-013 R7: Without systemd, every verb returns the platform-naming error and no subprocess runs
- [ ] A-014 R8: `on` and `off` refuse a file at the unit path that lacks `ManagedMarker`
- [ ] A-015 R6: A `nologin`/`false`/relative login shell makes `on` fail clearly
- [ ] A-016 R10: A failing `loginctl` or `systemctl show` degrades the field (nil/empty + hint) instead of failing `status`

### Code Quality

- [ ] A-017 Pattern consistency: New code follows naming and structural patterns of surrounding code (cmd-level seams as func vars or struct fields, `fsatomic`, `selfpath`)
- [ ] A-018 No unnecessary duplication: Existing utilities reused (`internal/fsatomic`, `internal/selfpath`, `internal/shellq`, `outputSink.Envelope`)
- [ ] A-019: Every subprocess uses `exec.CommandContext` with an argv slice and a timeout, never a shell string from Go
- [ ] A-020: Functions stay focused (no god functions over ~50 lines without reason); constants are named (unit name, timeouts, env list)
- [ ] A-021: Comments state constraints only (no narration, no change IDs)
- [ ] A-022: New behavior is covered by Go unit tests run via `just test-backend`

### Security

- [ ] A-023 R5: Paths interpolated into the unit are validated (absolute, no control characters) and escaped for systemd (`\ " % $`) and shell-quoted for the login shell, so no injection reaches ExecStart

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | systemd presence = `systemctl` on PATH ∧ `/run/systemd/system` exists (sd_booted) | Standard sd_booted(3) check; cheap, testable via seams | S:65 R:85 A:80 D:70 |
| 2 | Confident | `Changed` for `on` = file written OR `is-enabled` was not `enabled` before | Gives truthful "already on" without parsing `enable` output | S:60 R:90 A:75 D:65 |
| 3 | Confident | The rc-file caveat hint is per shell: zsh → `~/.zprofile` vs `~/.zshrc`; bash → `~/.profile`/`~/.bash_profile` vs `~/.bashrc`; others generic | S1 § Environment items 1–2; naming the user's real files makes the hint actionable | S:65 R:90 A:75 D:65 |
| 4 | Confident | Unit file mode 0644, parent dir 0755 | Conventional for systemd unit files; contains no secrets | S:60 R:95 A:85 D:85 |
| 5 | Confident | Real-system validation = `systemd-analyze --user verify` on hand-rendered copies of the golden unit (plus an escaped-path variant) and a read-only `rk daemon autostart status` from a scratch build; no test helper and no new flag | Read-only against the live user manager; rig safety forbids registering | S:60 R:95 A:80 D:70 |
| 6 | Confident | A missing/moved rk path surfaces through `Stale` (the fresh render differs) rather than parsing ExecStart back out of the unit | A changed path always changes the render; avoids a second parser of our own file | S:60 R:90 A:75 D:70 |
| 7 | Confident | Every package-level identifier in systemd.go/systemd_test.go is prefixed `systemd` | Both backends share package `autostart`; agreed with A2 to avoid post-merge symbol clashes neither PR's CI would catch | S:85 R:90 A:90 D:85 |

7 assumptions (1 certain, 6 confident, 0 tentative).
