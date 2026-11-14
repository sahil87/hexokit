# Plan: Operator Run Explicit Server

**Change**: 261114-qxos-operator-run-explicit-server
**Intake**: `intake.md`

## Requirements

### Operator loop: run launcher environment

#### R1: Launcher inherits the run's tmux server
`operatorloop.Exec` SHALL start the launcher with an explicit environment: the wrapper's process environment with `TMUX` restored from `tmux.OriginalTMUX` when it is non-empty (the `cliChildEnv` pattern, `cmd/rk/agent_kickoff.go`), plus `RK_OPERATOR_RUN_LOG=<absolute run log path>` (R6). Without this the launcher inherits the environment `internal/tmux`'s `init()` stripped, and every bare tmux/rk/fab call inside the run targets the `default` server.

- **GIVEN** the wrapper process started with `TMUX=/tmp/tmux-1000/loom,123,0`
- **WHEN** `Exec` runs the launcher
- **THEN** the launcher's environment has `TMUX=/tmp/tmux-1000/loom,123,0`
- **AND** `RK_OPERATOR_RUN_LOG` equals the run's `<run-id>.log` absolute path

- **GIVEN** the wrapper process started without `TMUX`
- **WHEN** `Exec` runs the launcher
- **THEN** the launcher's environment has no `TMUX` entry, and `RK_OPERATOR_RUN_LOG` is still set

#### R2: Run-log header line
Before starting the launcher, the wrapper SHALL write one line to the run log and the window's stdout:

```
run-exec: server=<server> run=<run-id> tmux=<socket|unset> cwd=<cwd> launcher=<shell-quoted argv>
```

`tmux=` is the socket part of the restored `TMUX` (before the first comma), or `unset`. When `TMUX` is set and its socket basename does not equal `--server`, the line SHALL end with ` WARNING: TMUX socket does not match --server`. Socket basename `default` matches server `default`. The header is not an `outcome:` line and does not affect outcome capture or the failure contract.

- **GIVEN** `--server loom` and `TMUX=/tmp/tmux-1000/hexokit,1,0`
- **WHEN** the run starts
- **THEN** the run log's first line starts with `run-exec: server=loom` and ends with `WARNING: TMUX socket does not match --server`

### Operator brief: explicit server

#### R3: Every server-addressed rk command renders with `-L <server>`
The rendered brief SHALL show `-L <server>` on every `rk mux`, `rk operator`, `rk tab` and `rk riff` command in the Rules, Interim autopilot and Exit contract sections. `<server>` is `BriefInput.Server`, or `default` when it is empty. The embedded markdown carries the literal token `-L <server>` (readable raw), and `RenderBrief` substitutes it. Placement is right after the verb path, before positional arguments (e.g. `rk mux capture -L loom <pane> --lines 40 …`, `rk operator track note -L loom <id> "<text>" --by run`, `rk tab new -L loom --cwd …`, `rk riff -L loom …`). Prose mentions of a verb family are rewritten to carry the flag too (e.g. "`rk operator track -L loom` verbs"). `rk notify` carries no `-L`. The output stays byte-identical for identical input.

- **GIVEN** a brief for server `loom`
- **WHEN** it is rendered
- **THEN** every occurrence of `rk mux`, `rk operator`, `rk tab` or `rk riff` in it is followed by its verb words and then `-L loom`
- **AND** the literal token `-L <server>` appears nowhere in the output

- **GIVEN** a brief with an empty server
- **WHEN** it is rendered
- **THEN** the commands carry `-L default`

#### R4: Always-pass-`-L` rule line
The Rules section SHALL contain the rendered line: "Every `rk mux`, `rk tab`, `rk riff` and `rk operator` command in this run passes `-L <server>`, exactly as written here. Never drop it or rely on `$TMUX`." (with `<server>` substituted).

- **GIVEN** a brief for server `loom`
- **WHEN** it is rendered
- **THEN** the Rules section contains "passes `-L loom`, exactly as written here"

#### R5: Rendered command shapes parse
Every distinct rendered command shape (`rk mux capture|send|inventory`, `rk operator track <verb>`, `rk operator brief`, `rk tab new`, `rk riff`) SHALL accept `-L <server>` in the rendered position. A `cmd/rk` test runs each shape through cobra flag parsing (without executing it) and asserts the `server` flag value.

- **GIVEN** `rk mux capture -L loom %27 --lines 40 --classify --json`
- **WHEN** cobra parses it
- **THEN** the resolved command is `mux capture`, its `server` flag is `loom`, and parsing raises no error

### rk CLI: self-logging into a run log

#### R6: Invocation record when `RK_OPERATOR_RUN_LOG` is set
When the env var `RK_OPERATOR_RUN_LOG` holds an absolute path, every `rk` invocation SHALL append one record to that file when `execute()` finishes:

```
--- rk 2026-11-14T11:10:20Z pid=12345 exit=1
argv: rk mux capture -L loom %27 --lines 40 --classify --json
error: <err.Error()>
stderr: <last 4 KiB of what was written through the root's stderr stream>
stdout: <last 2 KiB of what was written through the root's stdout stream>
```

- The timestamp is UTC RFC3339. `exit` is `exitCode(err)` (0 on success).
- `argv` is `os.Args` with `argv[0]` replaced by `rk`, quoted with `shellq.QuoteArgv`.
- The `error:` line appears only for a non-nil error. A `stderr:`/`stdout:` line is omitted when that stream is empty. A truncated stream's value starts with `…[truncated]`. Newlines inside a stream are kept, and each continuation line is indented by two spaces so the block stays readable.
- The record is written with one `write(2)` on a file opened `O_APPEND|O_CREATE|O_WRONLY`, mode 0600.
- Capture comes from tees on `rootCmd.SetOut` (wrapping the existing `writeTracker`) and `rootCmd.SetErr`, which also catches cobra's own `Error: …` line. Output written straight to `os.Stderr` is not captured; the `error:` line covers the failure text.
- The constant `RunLogEnv = "RK_OPERATOR_RUN_LOG"` and the record writer live in `internal/operatorloop` (single owner, shared with R1). `cmd/rk` already imports `internal/operatorloop`.

- **GIVEN** `RK_OPERATOR_RUN_LOG=/abs/run.log` and a command that fails with exit 1
- **WHEN** it finishes
- **THEN** `/abs/run.log` gains one record with `exit=1`, the argv, the `error:` line and the stderr tail

#### R7: Self-logging is fail-silent and opt-in
An unset, empty or relative `RK_OPERATOR_RUN_LOG`, or a path that cannot be opened or written, SHALL leave rk's exit code, stdout and stderr exactly as they would be without the variable, and write nothing. When the variable is unset, no tee wrapping affects behavior: `writeTracker` semantics (the JSON-envelope "already wrote" guard) are preserved in all cases.

- **GIVEN** `RK_OPERATOR_RUN_LOG=/nonexistent-dir/x.log`
- **WHEN** a command runs
- **THEN** its exit code and output are unchanged, and no error mentions the log

### Operator state: no silent wrong-ledger fallback

#### R8: A named server with an unknown socket path is an error
State-path resolution for a server label other than `default` SHALL fail with `tmux socket path for server "<name>" unavailable (is the server running?)` when the socket-path query returns `""`, instead of resolving to the `default` slug. The `default` label keeps the existing fallback to `default.yaml`. The rule is implemented once in `internal/operator` (e.g. `StatePathFor(server, socketPath string) (string, error)`) and used by both `operator.StatePathForServer` (backing `operator.Check`, so the daemon's check and `rk operator check`) and `cmd/rk`'s `operatorStateTarget` (backing `rk operator track *`, `rk operator brief`, `rk operator adopt`'s target). From the CLI the error is operational (exit 1). `rk operator brief --state <path>` bypasses resolution and is unaffected.

- **GIVEN** `rk operator track list -L loom --json` and a socket query that fails
- **WHEN** it runs
- **THEN** it exits 1 with an error naming `loom`, and reads no `default.yaml`

- **GIVEN** `rk operator track list --json` outside tmux with no `default` server
- **WHEN** it runs
- **THEN** it reads `default.yaml`, as today

### Non-Goals

- Rendering `claude -p --output-format stream-json`: rejected at intake because it's Claude-only and breaks the provider-opaque launcher rule.
- Capturing git/gh tool output in the run log: self-logging covers rk only, per the user's choice.
- Changing the static `rk skill operator` chat topic: it's session-agnostic by contract.
- Changing `logTail`'s 200-byte failure-note excerpt. It now may show a self-log record's tail when rk ran last, which is equally diagnostic.

### Design Decisions

#### Restore TMUX for the run launcher
**Decision**: `run-exec` hands the launcher its own captured `TMUX` (from `tmux.OriginalTMUX`), and the brief also renders `-L <server>` on every server-addressed rk command.
**Why**: `internal/tmux`'s `init()` strips `TMUX` process-wide, so a child of any rk binary loses its server unless it's restored. Every bare tmux/rk/fab call in a run then targeted `default`, so the loom run's capture failed and it read `default.yaml`. Explicit `-L` keeps a future env regression from silently retargeting a run.
**Rejected**: Brief `-L` alone (bare tools such as `fab pane map` and `tmux` still need `$TMUX`). Env restore alone (one regression away from the same silent failure).
*Introduced by*: 261114-qxos-operator-run-explicit-server

#### rk self-logs into the run log
**Decision**: `run-exec` exports `RK_OPERATOR_RUN_LOG`, and every rk invocation appends its argv, exit, error and capped streams to the run log.
**Why**: Provider-neutral and deterministic. The run's allowlist is mostly rk verbs, and a plain `claude -p` log holds only the final prose.
**Rejected**: Stream-json rendering for Claude launchers (Claude-only, breaks provider opacity). A brief-only "quote the error" rule (depends on model compliance).
*Introduced by*: 261114-qxos-operator-run-explicit-server

#### Named servers never fall back to the default ledger
**Decision**: An unknown socket path for a non-`default` server is an error in every state-path resolution. `default` keeps its fallback.
**Why**: The silent fallback is what made the loom run read an empty ledger and report "no step6a item". The daemon's run-file path already refused this.
**Rejected**: Removing the fallback for `default` too (it would break plain-shell `rk operator track` with no tmux server).
*Introduced by*: 261114-qxos-operator-run-explicit-server

## Tasks

### Phase 1: Core Implementation

- [x] T001 [P] Add the shared state-path rule in `app/backend/internal/operator/store.go` (`StatePathFor(server, socketPath)`, erroring for non-`default` servers with an empty socket path). Route `StatePathForServer` through it, and route `cmd/rk/operator_track.go` `operatorStateTarget` through it (keep the `operatorSocketPathFn` seam). Tests: `internal/operator/store_test.go` (named → error, `default` → `default.yaml`) and `cmd/rk/operator_track_test.go` (named server with a failing socket seam exits 1 naming the server; `default` still resolves). Fix any existing tests that relied on the named-server fallback. <!-- R8 -->
- [x] T002 [P] Brief `-L`: in `app/backend/internal/operator/brief_rules.md` and `brief_autopilot.md`, add the literal `-L <server>` token to every `rk mux`/`rk operator`/`rk tab`/`rk riff` command and verb-family mention (after the verb path), and add the R4 rule line to Rules. In `brief.go`, add `-L <server>` to `briefExitContract`, add a named token constant, and substitute it with `-L <server-or-default>` in `renderBriefLayout` for the three sections. Regenerate `testdata/brief_golden.md` (`UPDATE_GOLDEN=1`). In `brief_test.go`, add tests: every `rk (mux|operator|tab|riff)` occurrence is followed by verb words then `-L <server>`; the raw token never survives; an empty server renders `-L default`; the R4 line is present. Keep the ≤ 40 960-byte embed cap test green. <!-- R3 R4 -->
- [x] T003 [P] Self-log writer in new `app/backend/internal/operatorloop/runlog.go`: `RunLogEnv` const, a capped tail buffer type (`io.Writer` keeping the last N bytes, with a truncated flag), and `AppendInvocation(path string, inv Invocation)` producing the R6 record in one `O_APPEND` write, fail-silent, with absolute paths only. Tests in `runlog_test.go`: format, caps and truncation marker, omitted empty streams, continuation indentation, relative or unwritable path writes nothing. <!-- R6 R7 -->

### Phase 2: Integration

- [x] T004 Wire self-logging into `app/backend/cmd/rk/root.go` `execute()`: when `RunLogEnv` holds an absolute path, wrap the stdout `writeTracker` and the stderr in tees to capped tail buffers (stdout 2 KiB, stderr 4 KiB), and after `ExecuteC` call `operatorloop.AppendInvocation` with argv (`rk` + `os.Args[1:]`), `exitCode(err)`, and the error, before `os.Exit`. With the variable unset, behavior is byte-identical. Factor the logic into a small testable helper rather than growing `execute()`. Tests in `cmd/rk`: a failing and a succeeding invocation append correct records, and an unwritable path changes nothing. <!-- R6 R7 -->
- [x] T005 Launcher env and header in `app/backend/internal/operatorloop/exec.go` `runLauncher`: set `cmd.Env` = `os.Environ()` + restored `TMUX` (from `tmux.OriginalTMUX`, via a test seam var) + `RunLogEnv=<logPath>`. Write the R2 header line to the log and `opts.Stdout` before `cmd.Run`, with the mismatch warning (cwd from `os.Getwd`, launcher via `shellq.QuoteArgv`). Tests in `exec_test.go`: a stub launcher prints `TMUX` and `RK_OPERATOR_RUN_LOG` (set / unset cases); the header line is present; the mismatch warning appears for another socket and is absent for a match; outcome capture is unaffected by the header. Make `cmd/rk/agent_kickoff.go` `cliChildEnv` and this share one helper only if that's cycle-free and trivial, otherwise leave both. <!-- R1 R2 -->
- [x] T006 Add a `cmd/rk` test asserting every rendered brief command shape parses with `-L` (R5): for each shape (`mux capture|send|inventory`, `operator track list|note|update|add|rm|pause|observe`, `operator brief`, `tab new`, `riff`), run `rootCmd.Find` + `ParseFlags` on the argv taken from the rendered brief form and check the `server` flag equals the server, without executing RunE. Then run `cd app/backend && gofmt -l . && go vet ./... && go test ./...` and fix failures. <!-- R5 -->

## Execution Order

- T001, T002 and T003 are independent.
- T003 blocks T004 and T005 (they use `RunLogEnv` / `AppendInvocation`).
- T002 blocks T006 (it parses the rendered shapes).

## Acceptance

### Functional Completeness

- [ ] A-001 R1: The launcher's environment carries the wrapper's original `TMUX` when set, and always carries `RK_OPERATOR_RUN_LOG=<run log path>`
- [ ] A-002 R2: The run log starts with the `run-exec:` header line (server, run, tmux socket or `unset`, cwd, launcher)
- [ ] A-003 R3: Every `rk mux`/`rk operator`/`rk tab`/`rk riff` occurrence in the rendered Rules, Interim autopilot and Exit contract carries `-L <server>` after its verb path, `rk notify` carries none, and the golden brief is regenerated
- [ ] A-004 R4: The Rules section contains the rendered always-pass-`-L` line
- [ ] A-005 R5: A test proves every rendered command shape parses with the `server` flag set
- [ ] A-006 R6: With `RK_OPERATOR_RUN_LOG` set, an rk invocation appends one record with time, pid, exit, argv, error (on failure), and capped stderr/stdout
- [ ] A-007 R8: A non-`default` server with an empty socket path errors in both `operator.StatePathForServer` and `operatorStateTarget`

### Behavioral Correctness

- [ ] A-008 R8: `rk operator track …` for the `default` label with no running server still resolves to `default.yaml`
- [ ] A-009 R7: With `RK_OPERATOR_RUN_LOG` unset, `execute()` output, exit codes and the JSON-envelope guard behave exactly as before

### Scenario Coverage

- [ ] A-010 R2: Tests cover the mismatch warning (present for a foreign socket, absent for a matching one, `default` ↔ `default`)
- [ ] A-011 R3: Tests cover the empty-server case rendering `-L default` and the raw token never surviving

### Edge Cases & Error Handling

- [ ] A-012 R7: A relative, empty or unwritable `RK_OPERATOR_RUN_LOG` writes nothing and changes no exit code or output
- [ ] A-013 R6: Streams over the cap are tail-truncated with the `…[truncated]` marker, and empty streams' lines are omitted
- [ ] A-014 R2: Outcome capture and the failure contract are unaffected by the header line (an `outcome:` line still wins, and a no-outcome run still fails)

### Code Quality

- [ ] A-015 Pattern consistency: New code follows naming and structural patterns of surrounding code (test seams as package vars, `exec.CommandContext` argv, no inline tmux commands)
- [ ] A-016 No unnecessary duplication: `RunLogEnv` and the record writer have one owner; the state-path rule is implemented once in `internal/operator`
- [ ] A-017 Readability: `execute()` stays small; self-log logic lives in a helper; no god functions
- [ ] A-018 Tests: Every requirement's behavior is covered by Go tests, and `go test ./...` passes
- [ ] A-019 No magic strings: the env var name, caps and the `-L <server>` token are named constants
- [ ] A-020 Comments: no comment narration; comments state only constraints the code can't show

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The brief markdown carries the literal `-L <server>` token, substituted by `RenderBrief` | Raw files stay readable, and the substitution is deterministic and golden-testable | S:75 R:85 A:80 D:70 |
| 2 | Confident | `-L` goes right after the verb path (`rk mux capture -L loom <pane>`) | All target verbs register `-L` as a persistent or local flag; R5's test proves parsing | S:70 R:90 A:80 D:70 |
| 3 | Confident | The named-server error rule also covers `operator.StatePathForServer` (daemon check / `rk operator check`) | Same wrong-ledger hazard on the same code path; one rule, one owner | S:65 R:80 A:80 D:70 |
| 4 | Confident | `RunLogEnv` and the record writer live in `internal/operatorloop` | `cmd/rk` already imports it, and the wrapper sets the variable there | S:70 R:90 A:80 D:70 |
| 5 | Tentative | Self-log captures cobra streams only, plus an `error:` line; raw `os.Stderr` writes are not captured | Teeing `os.Stderr` process-wide is invasive; the error text covers the failure case | S:55 R:85 A:65 D:50 |
| 6 | Confident | The `logTail` 200-byte failure excerpt is unchanged | Self-log records are equally diagnostic as a tail; a change is out of scope | S:60 R:90 A:75 D:70 |

6 assumptions (0 certain, 5 confident, 1 tentative).
