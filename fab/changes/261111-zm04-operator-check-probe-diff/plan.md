# Plan: Operator Check — probe runner + diff as an in-daemon function

**Change**: 261111-zm04-operator-check-probe-diff
**Intake**: `intake.md`

## Requirements

All paths below are relative to `app/backend/` unless they start with `fab/` or `docs/`. Source of the port: fab-kit `src/go/fab/cmd/fab/operator_tick_start.go` (functions `diffPaneItems`, `tickCompleted`, `runDueProbesUntil`, `runOneProbe`, `fieldChanges`, `deriveItemDeltas`, `probeDue`) and its tests `operator_tick_diff_test.go`, at `~/code/sahil87/fab-kit` (read-only reference — never modify fab-kit).

### Operator: Check function

#### R1: `operator.Check` is a library function with a two-phase lock discipline
`internal/operator` SHALL export `Check(ctx context.Context, server string, opts CheckOptions) (CheckResult, error)`. It SHALL resolve the state path with `StatePathForServer(ctx, server)`. Phase 1 SHALL `Load` the file without the lock, take at most one pane snapshot of `server` (only when some `probe.mode == pane` item has a non-null `scope.pane`), and run the due shell probes; it SHALL write nothing. Phase 2 SHALL run a single `Mutate` that re-reads the file, applies phase-1 observations only to items still present by id, derives conditions/deltas against the re-read state, and writes once. A probe outcome SHALL be applied only when the item's `probe.argv` and `checked_at` equal their phase-1 values; otherwise it SHALL be discarded. An item absent in phase 1 SHALL be evaluated without a probe result. An empty `tracked` list SHALL take no pane snapshot and run no probes, return `changed: false`, and still write `last_check_at`. `CheckOptions` SHALL carry `Budget time.Duration` (zero ⇒ 60 s).

- **GIVEN** a shell item whose probe takes 8 s
- **WHEN** `Check` runs and, concurrently, `AddNote` is called on another item
- **THEN** `AddNote` succeeds (no lock is held while the probe runs)
- **AND** the final file contains both the note and the probe outcome

- **GIVEN** an item observed via `track observe` between phase 1 and phase 2 (its `checked_at` moved)
- **WHEN** phase 2 applies
- **THEN** the check's probe outcome for that item is discarded and the external observation stands

#### R2: Pane state is read from rk's own data
The pane snapshot SHALL come from `internal/tmux` session/window/pane listing for `server` (`tmux.PaneInfo`: `PaneID`, `Cwd`, `Command`, `PanePID`, reconciled `AgentState`, `AgentStateEpoch`, `AgentPID`), with change/stage/display state derived from the pane cwd's `.fab-status.yaml` by the same logic `internal/sessions/fabstate.go` uses today. Pane pids SHALL come from the same listing (no second tmux call). fab's CLI SHALL NOT be invoked.

- **GIVEN** a server with no fab installed and a tracked pane item
- **WHEN** `Check` runs
- **THEN** the pane item is evaluated from tmux data alone (stage-derived deltas simply do not occur)

#### R3: Pane deltas — fab's semantics and precedence
For each pane item with non-null `scope.pane` and no `done_at`, `Check` SHALL evaluate, first match wins:
1. `pane_death` (pane absent from snapshot; baselines untouched);
2. `pane_mismatch` (recorded non-zero `scope.pane_pid` ≠ current `PanePID`; `found` = observed change id or null; a null/zero recorded pid joins on id alone);
3. `agent_exited` (`tmux.IsShellCommand(Command)` AND no live agent: reconciled `AgentState` empty or `AgentPID` 0, AND the process-tree walk from `PanePID` finds no agent; a walk error counts as "agent alive" — no evidence; `command` = the foreground command);
4. clean join, which in order: (a) observed change id non-empty and ≠ `scope.change` → `changed` delta `fields: {change: {from, to}}`, baseline updated, an unresolved observation never clears it; (b) `branch_map` gains `{branch, repo}` for an observed change without an entry when `scope.repo` is non-empty and `git -C <cwd> branch --show-current` returns a non-empty branch (failures skip silently, retried next check); (c) built-in completion when `scope.change` is non-null and the stage is resolved — `stop_stage` null ⇒ stage `ship` with display state `done`/`skipped`; `stop_stage` set ⇒ stage index past the stop stage (order `intake, apply, review, hydrate, ship, review-pr`) or equal with `done`/`skipped` — persisting `done_at` in the same write; (d) resolved stage ≠ non-empty `scope.stage` → `stage_advance` (`review→apply` ⇒ `review_fail`) with `pane, from, to`, baseline updated; (e) `scope.agent` ← observed agent state (null when empty); a transition into `waiting` or `idle` from any other value SHALL emit an `agent_state` delta with `pane, from, to, duration` (rk's `sessions.FormatAgentDuration`-equivalent formatting from `AgentStateEpoch`); transitions to `active`/unknown SHALL update silently.

A pane item with `done_at` set SHALL be treated as done and neither joined nor diffed.

- **GIVEN** a pane item whose recorded `pane_pid` is 100 and the pane `%5` now has `PanePID` 200
- **WHEN** `Check` runs
- **THEN** a `pane_mismatch` condition is produced and no stage/agent baseline changes

- **GIVEN** a pane item with `scope.stage: review` and the pane's change now at `apply`
- **WHEN** `Check` runs
- **THEN** a `review_fail` delta `{from: review, to: apply}` is produced and `scope.stage` becomes `apply`

- **GIVEN** `scope.agent: active` and the pane now reports `waiting`
- **WHEN** `Check` runs
- **THEN** an `agent_state` delta `{from: active, to: waiting}` is in `changes`; on the next check with the pane still waiting no new `agent_state` delta is produced

#### R4: Shell probe runner with ghprobe gating
A shell item is due when not paused, not done, and `checked_at` is null/unparsable or `now − checked_at ≥ check_every` (missing/invalid `check_every` ⇒ 5 m). Due probes SHALL run sequentially until the budget deadline; probes not started by then SHALL produce a non-gating notice `skipped (check budget)` with nothing written for that item. The runner SHALL `exec.LookPath(argv[0])` and then run argv-only `exec.CommandContext` bounded by the 10 s `probeTimeout`, inheriting the environment; errors compose to one line (`exit <n>: <first stderr line>`, `timeout after 10s`, or the lookup error). For `kind: github-pr` items the runner SHALL first consult `ghprobe.Available`; when false the item SHALL be skipped with `checked_at`/`failures` untouched and a non-gating notice `gh unavailable`. On a completed run `checked_at` ← now. Failure or a non-JSON-object stdout ⇒ `failures++`, `paused` set at `failures ≥ 3`, and a non-gating `probe_error` notice. Success ⇒ `failures = 0`; `last` candidate = declared `probe.fields` extracted (dotted, absent ⇒ null; R1's `extractProbeFields` + `normalizeJSONNumbers`); equal to `last` ⇒ `unchanged++`; different ⇒ `changed` delta with per-field `{from, to}` for differing declared fields, `unchanged = 0`, `last` ← new, `updated_at` ← now. Done items SHALL never be probed.

- **GIVEN** a github-pr item with `last: {state: OPEN}` and a probe returning `{"state":"MERGED",...}`
- **WHEN** `Check` runs
- **THEN** `changes` contains `changed` with `fields.state = {from: OPEN, to: MERGED}` and, because `done_when` now holds, a `done` condition

- **GIVEN** gh is not available
- **WHEN** `Check` runs with a due github-pr item
- **THEN** no subprocess runs for it, its `failures` and `checked_at` are unchanged, and `notices` contains `gh unavailable` for it

- **GIVEN** a shell item with `failures: 2`
- **WHEN** its probe fails again
- **THEN** `failures` is 3, `paused` is true, and a new `paused` condition is in `changes`

#### R5: Agent-probe items are marked due, never queried
`linear`/`slack` items (probe mode `agent`) SHALL never be executed by `Check`. A not-paused, not-done agent item past its `check_every` (base = `checked_at`, else `added_at`) SHALL produce a `due` condition carrying `age` and `instruction`; an agent item past `2 × check_every` SHALL additionally produce `stale` with `age`.

- **GIVEN** a linear item checked 6 m ago with `check_every: 5m`
- **WHEN** `Check` runs twice without an intervening `track observe`
- **THEN** the first check puts `due` in `changes`, the second lists it under `open`

#### R6: Edge-triggered conditions via the `reported` field
`TrackedItem` SHALL gain `Reported []string` (`yaml:"reported,omitempty" json:"reported,omitempty"`) placed after `Notes`. Each check SHALL compute each item's current condition-key set: `done`; `pane_death`; `pane_mismatch`; `agent_exited`; `agent:waiting` / `agent:idle` (clean join in that state); `paused` (paused with `failures ≥ 3`); `stale`; `due@<base timestamp>`; `unknown_dep:<id>`. A done item's set is `{done}` plus any `unknown_dep:*`; a user-paused item below the cap yields only `done`/`unknown_dep:*`. A key absent from the stored `reported` SHALL put its delta into `changes`; a key present SHALL put it into `open`. After evaluation `reported` SHALL be replaced by the current set, sorted (empty ⇒ omitted). Event deltas (`changed`, `stage_advance`, `review_fail`, `agent_state`) SHALL always go to `changes`. `changed` SHALL be `len(changes) > 0`. `Reported` SHALL be written only by `Check`; adopt SHALL not set it; `track list --json` SHALL show it.

- **GIVEN** a pane item whose pane disappeared
- **WHEN** `Check` runs three times
- **THEN** `pane_death` is in `changes` on the first run and in `open` on the second and third
- **AND** if the pane id reappears and disappears again later, `pane_death` is in `changes` again

#### R7: `last_check_at`
Every successful `Check` SHALL write a top-level `last_check_at` (RFC3339 UTC, from the package `clock`) as a typed field of `State` (`LastCheckAt string`), decoded on read and written on marshal only when non-empty, so it is not treated as an unknown extra key. Other verbs SHALL preserve it unchanged.

- **GIVEN** a state file with `last_check_at` set
- **WHEN** `track note` mutates the file
- **THEN** `last_check_at` is unchanged

#### R8: Result shape
`CheckResult` SHALL be `{checked_at, changed, changes, open, notices}` (JSON names as written), lists marshaling as `[]` when empty. `CheckDelta` SHALL carry `kind, id` and, per kind: `pane` (pane kinds, `agent_state`, `stage_advance`, `review_fail`), `fields` (`changed`), `then` (`done`; the item's `then` or null), `age` (`stale`, `due`), `instruction` (`due`), `error`/`failures`/`paused` (`paused`), `found` (`pane_mismatch`, nullable), `command` (`agent_exited`, nullable), `from`/`to` (`stage_advance`, `review_fail`, `agent_state`), `duration` (`agent_state`), `dep` (`unknown_dep`). Kinds: `changed, done, pane_death, pane_mismatch, agent_exited, stage_advance, review_fail, agent_state, paused, stale, due, unknown_dep`. `CheckNotice` SHALL be `{id, kind, error, failures}` with kinds `probe_error`, `skipped`, `gh_unavailable`. Deltas SHALL be ordered by tracked-list order, then emission order.

- **GIVEN** a check with no conditions anywhere
- **WHEN** marshaled to JSON
- **THEN** it is `{"checked_at": "...", "changed": false, "changes": [], "open": [], "notices": []}`

### Shared packages

#### R9: fab-state derivation and process-tree walk are shared internal packages
The `.fab-status.yaml` derivation (`locateFabStatusLink`, `parseFabStatusLink`, `parseProgressStates`, `fabDisplayStage`, the per-call memo) SHALL move from `internal/sessions/fabstate.go` to a new exported package `internal/fabstatus`; `internal/sessions` SHALL call it with unchanged behavior. The process-tree walk (`discoverProcessTree` per OS, `processNode`, `classifyProcess`, `agentCommNames`, `markAgentPID`, `hasAgentInTree`, `paneHasAgent`, `parsePSCmdlines`, `processBasename`) SHALL move from `cmd/rk/mux_process*.go` to a new package `internal/proctree`; `rk mux process` and `rk mux panes` SHALL call it with byte-identical output. `internal/operator` SHALL import neither `internal/sessions` nor anything under `cmd/`.

- **GIVEN** the existing `cmd/rk` mux tests and `internal/sessions` tests
- **WHEN** `go test ./...` runs after the move
- **THEN** they pass unchanged (tests moved alongside code may be relocated, not weakened)

### CLI: `rk operator check`

#### R10: `rk operator check [--json] [-L <server>]`
A new `check` subcommand of `operatorCmd` (`cmd/rk/operator_check.go`) SHALL resolve the server exactly as `operator track` does (persistent `-L/--server`, default from `$TMUX` via `cliServerLabel(operatorOriginalTMUXFn())`, validated with `validate.ValidateServerName`, failure = usage error), call `operator.Check` in-process, and write baselines exactly as the daemon will. Human output: a header `no change` or `changed <n>`, followed by `open <n>` / `notices <n>` counts when non-zero, then one line per delta prefixed `new` (changes) or `open`, and per notice `note`, each `<prefix>  <id>  <kind>  <detail>`. `--json` SHALL emit `CheckResult` through the shared `outputSink` envelope. Exit codes: 0 success (with or without changes), 1 operational (state unreadable, `ErrBusy`, tmux listing failure), 2 usage. Help SHALL carry Examples and Exit codes sections with no backticks in flag help; the command SHALL NOT be added to the MCP allowlist.

- **GIVEN** a server with one new `changed` delta
- **WHEN** `rk operator check --json` runs
- **THEN** stdout is the envelope `{"ok": true, "result": {..., "changed": true, "changes": [{"kind": "changed", ...}]}}` and the exit code is 0

- **GIVEN** `-L 'bad name!'`
- **WHEN** `rk operator check` runs
- **THEN** it exits 2 without touching any file

### Non-Goals

- Daemon wiring, a cron entry kind, run launch, Cron Log rows — R5.
- Drawer / sessions payload reading rk's file — R3.
- Run brief / chat skill — R4.
- fab's render frame: `tick_count`, `last_tick_at`, `last_full_at`, `--quiet`, `fleet_summary`, `items:` rows, `candidates:`.
- `--dry-run` on `rk operator check`.
- Parallel probe execution.
- Any change to fab-kit, the live rk daemon, or installed binaries.

### Design Decisions

#### Edge-triggered standing conditions
**Decision**: Standing conditions (done, pane death/mismatch, agent exited, waiting/idle, failure-pause, stale, due, unknown dependency) are reported in `changes` once, when their key first appears in an item's condition set, then listed in `open`; the item's `reported` field holds the last-reported set.
**Why**: Under the run loop every change launches a paid model run; fab's level-triggered re-emission would relaunch a run on every fire for a condition a run chose to leave alone.
**Rejected**: Porting fab's level-triggered deltas (cost repeats until a run acks); a separate cursor sidecar (memory split from the item, extra file to reconcile).
*Introduced by*: 261111-zm04-operator-check-probe-diff

#### Probe outside the lock
**Decision**: The check observes (pane listing, probes) lock-free, then applies all results in one `Mutate`, discarding a probe outcome whose item's `checked_at` or argv moved meanwhile.
**Why**: Probes can take up to the 60 s budget while R1's lock gives up after 5 s; the chat, runs, and daemon all write the same file, and external writes must win (Constitution II).
**Rejected**: Probing inside the mutation as fab does (writers hit `ErrBusy`); raising the lock timeout (still blocks the chat for a minute).
*Introduced by*: 261111-zm04-operator-check-probe-diff

#### Pane facts from rk, not fab
**Decision**: Pane state comes from rk's tmux listing, its reconciled agent state, its `.fab-status.yaml` derivation, and its process-tree walk, moved into `internal/fabstatus` and `internal/proctree` so `internal/operator` can import them.
**Why**: The operator must work without fab; `cmd/rk` is package main and `internal/sessions` will import `internal/operator` (R3), so the shared pieces need neutral homes.
**Rejected**: Shelling out to `fab pane map` (fab dependency, subprocess per check); importing `internal/sessions` from `operator` (import cycle once R3 lands).
*Introduced by*: 261111-zm04-operator-check-probe-diff

## Tasks

### Phase 1: Setup — shared packages

- [x] T001 Move the fab-state derivation from `internal/sessions/fabstate.go` into new package `internal/fabstatus` (exported `State{Change, Stage, DisplayState}`, `Memo` with `Derive(cwd)`/`WindowState(panes)` or equivalent); make `internal/sessions` delegate to it; move/adapt `internal/sessions/fabstate_test.go` coverage so nothing is lost; `go test ./internal/sessions/... ./internal/fabstatus/...` passes <!-- R9 -->
- [x] T002 Move the process-tree walk from `cmd/rk/mux_process.go`, `mux_process_linux.go`, `mux_process_darwin.go` into new package `internal/proctree` (exported `Node`, `Discover`, `PaneHasAgent(ctx, pid, agentPID)`, `HasAgent`, classification helpers as needed); keep `rk mux process`/`rk mux panes` output byte-identical by calling it; relocate the walk's unit tests from `cmd/rk/mux_process_test.go` as appropriate; `go test ./cmd/rk/... ./internal/proctree/...` passes <!-- R9 -->

### Phase 2: Core Implementation

- [x] T003 Add `Reported []string` after `Notes` in `TrackedItem` (`internal/operator/schema.go`) and typed `LastCheckAt` in `State` with read/write handling in `internal/operator/store.go` (`stateFromMap`, `marshal`; keep it out of `extra`); add store tests that `last_check_at` round-trips and survives another verb's mutation, and that `reported` survives a typed rewrite <!-- R6 --> <!-- R7 -->
- [x] T004 Create `internal/operator/check.go` with `CheckOptions`, `CheckResult`, `CheckDelta`, `CheckNotice` (JSON shapes per R8, nullable fields as pointers, empty lists as `[]`), the package-level seams (`paneSnapshotFn`, `agentAliveFn`, `probeRunnerFn`, `ghAvailableFn`, `gitBranchFn`), and the `Check` skeleton implementing the two-phase Load → observe → `Mutate` flow, the empty-list fast path, and `last_check_at` <!-- R1 --> <!-- R7 --> <!-- R8 -->
- [x] T005 Implement the pane snapshot (`paneSnapshotFn` default: `tmux` session/window listing on `server` → map pane id → row with `PaneInfo` fields + `fabstatus` derivation) and the pane diff per R3 in `internal/operator/check_pane.go`: precedence, sticky change/stage baselines, branch_map write via `gitBranchFn` (argv `git -C <cwd> branch --show-current`, `exec.CommandContext`, 10 s), built-in completion with `stop_stage`, `review_fail`, `agent_state` transitions (into waiting/idle only), `agent_exited` via `tmux.IsShellCommand` + `proctree` walk <!-- R2 --> <!-- R3 -->
- [x] T006 Implement the shell probe runner in `internal/operator/check_probe.go`: due rule, sequential execution under the budget deadline, `probeRunnerFn` default (LookPath + argv-only `exec.CommandContext` with `probeTimeout`, one-line error composition), `ghprobe.Available` gating for `github-pr`, outcome bookkeeping (`checked_at`, `failures`, pause at 3, `last`/`unchanged`, `fieldChanges` per declared fields), and the phase-2 apply guard on `checked_at`/argv <!-- R1 --> <!-- R4 -->
- [x] T007 Implement condition derivation and edge verdicts in `internal/operator/check.go` (or `check_conditions.go`): per-item condition keys (`done`, pane keys, `agent:*`, `paused`, `stale`, `due@<base>`, `unknown_dep:<id>`), done/user-paused inertness, new-vs-open split against `reported`, `reported` replacement (sorted), `due`/`stale` for agent items, event deltas always new, deterministic ordering <!-- R5 --> <!-- R6 --> <!-- R8 -->

### Phase 3: Integration & Edge Cases

- [x] T008 Add `cmd/rk/operator_check.go`: `rk operator check [--json]` under `operatorCmd`, sharing the `-L/--server` resolution used by `operator track` (reuse its helper; extract one if needed), human rendering per R10, `--json` via `outputSink` envelope, exit-code mapping (ErrBusy/IO/tmux ⇒ 1, usage ⇒ 2), help text with Examples and Exit codes sections <!-- R10 -->
- [x] T009 Write `internal/operator/check_test.go` (+ `check_pane_test.go`, `check_probe_test.go` as fits): port the relevant `operator_tick_diff_test.go` cases (each pane delta and precedence, sticky baselines, completion with/without stop_stage, review_fail, branch_map write/skip/retry, probe success/unchanged/changed/failure/pause-at-3/non-JSON/dotted fields, budget skip, done items not re-probed, unknown dependency) adapted to the edge model, plus new cases: new-then-open, clear-and-return fires again, `due@` once per period, `agent_state` only into waiting/idle, probe outcome discarded when `checked_at`/argv moved between phases, item removed during phase 1 ignored, gh unavailable skips without failure, `AddNote` succeeds while a stubbed probe blocks in phase 1, empty list no-op writes `last_check_at` <!-- R1 --> <!-- R3 --> <!-- R4 --> <!-- R5 --> <!-- R6 -->
- [x] T010 Write `cmd/rk/operator_check_test.go`: human output (no change / changes with open + notices), `--json` envelope shape, `-L` validation exit 2, `ErrBusy` exit 1, and confirm `rk help-dump` lists `operator check` (existing help-dump tests/fixtures updated only if they enumerate commands) <!-- R10 -->

### Phase 4: Polish

- [x] T011 Run the verification gates: `cd app/backend && go vet ./... && go test ./...`, plus `go build ./...`; also `GOOS=darwin go build ./...` to confirm the moved darwin walk compiles; do not start, restart, or install any rk daemon/binary <!-- R9 --> <!-- R10 -->

## Execution Order

- T001 and T002 are independent of each other and block T005.
- T003 blocks T004–T007.
- T004 blocks T005, T006, T007; T005 and T006 can proceed in either order before T007.
- T008 depends on T004–T007; T009 and T010 follow their code.

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `operator.Check(ctx, server, opts)` exists, resolves the path via `StatePathForServer`, performs no write in phase 1, and writes exactly once via `Mutate` in phase 2
- [ ] A-002 R2: Pane rows come from `internal/tmux` listing plus `internal/fabstatus`; no `fab` subprocess is invoked anywhere in `Check`
- [ ] A-003 R3: All pane deltas (`pane_death`, `pane_mismatch`, `agent_exited`, change appear/switch, `stage_advance`, `review_fail`, `agent_state`) and built-in completion are implemented with fab's precedence and sticky baselines
- [ ] A-004 R4: Shell probes run argv-only with LookPath, 10 s timeout, sequential under the budget, with fab's failure/pause/last/unchanged bookkeeping; github-pr probes are gated by `ghprobe.Available`
- [ ] A-005 R5: Agent-probe items are never executed; `due` and `stale` conditions are derived from `check_every`
- [ ] A-006 R6: `TrackedItem.Reported` exists after `Notes`, is written only by `Check`, and drives the new-vs-open split
- [ ] A-007 R7: `last_check_at` is a typed `State` field written by every check and preserved by other verbs
- [ ] A-008 R8: `CheckResult`/`CheckDelta`/`CheckNotice` JSON shapes match the requirement, with `[]` for empty lists
- [ ] A-009 R9: `internal/fabstatus` and `internal/proctree` exist; `internal/sessions` and `cmd/rk` mux commands use them; `internal/operator` imports neither `internal/sessions` nor `cmd/`
- [ ] A-010 R10: `rk operator check [--json] [-L]` exists with the specified output, envelope, exit codes, and help sections, and is absent from the MCP allowlist

### Behavioral Correctness

- [ ] A-011 R6: A standing condition appears in `changes` on its first check and in `open` on subsequent checks; a condition that clears and returns appears in `changes` again
- [ ] A-012 R3: An `agent_state` delta fires only on a transition into `waiting` or `idle`; staying in that state or moving to `active` produces none
- [ ] A-013 R4: A single probe failure below the cap is a notice and does not set `changed`; the third consecutive failure produces a gating `paused` condition

### Scenario Coverage

- [ ] A-014 R1: A test shows `AddNote` succeeding while a stubbed probe is blocked in phase 1
- [ ] A-015 R1: A test shows a probe outcome discarded when the item's `checked_at` moved between phases, and an item removed during phase 1 ignored
- [ ] A-016 R3: Ported fab tick-diff cases for each pane delta, completion with and without `stop_stage`, and branch_map write/skip/retry pass
- [ ] A-017 R5: A test shows `due@<base>` firing once per due period across consecutive checks
- [ ] A-018 R10: CLI tests cover human output, `--json` envelope, and exit codes 0/1/2

### Edge Cases & Error Handling

- [ ] A-019 R1: An empty tracked list takes no pane snapshot, runs no probe, returns `changed: false`, and writes `last_check_at`
- [ ] A-020 R4: gh unavailable leaves a github-pr item's `failures` and `checked_at` untouched and adds a `gh_unavailable` notice
- [ ] A-021 R4: Probes not started before the budget deadline produce `skipped` notices with nothing written for those items
- [ ] A-022 R3: A process-tree walk error is treated as "agent alive" (no `agent_exited`)
- [ ] A-023 R9: `rk mux process` and `rk mux panes` output is unchanged (existing tests pass without expectation changes)

### Code Quality

- [ ] A-024 Pattern consistency: New code follows `internal/operator` conventions (seams as package-level vars, `invalidf`/`InvalidError` for caller mistakes, clock-based RFC3339 UTC timestamps) and `cmd/rk/operator_track.go` CLI conventions
- [ ] A-025 No unnecessary duplication: R1 helpers (`extractProbeFields`, `getPathValue`, `normalizeJSONNumbers`, `itemDone`, `itemStale`, `checkEveryDuration`, `heldDep`, `stageNames`, `formatAge`) are reused, not re-implemented
- [ ] A-026: All subprocesses use `exec.CommandContext` with a timeout and argv slices; tmux access goes through `internal/tmux`
- [ ] A-027: No god functions — the pane diff, probe runner, and condition derivation are separate functions under ~50 lines each where practical
- [ ] A-028: Named constants for the budget, condition-key prefixes, and delta kinds; no magic strings scattered across files
- [ ] A-029: Comments state constraints/why only — no narration, no change IDs or PR numbers
- [ ] A-030: Constitution II — durable before acknowledged: `Check` returns success only after the atomic write; no in-memory cache of the state file

### Security

- [ ] A-031 R4: Probe argv is never joined into a shell string; `-L` server names are validated before any tmux call

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | New package names `internal/fabstatus` and `internal/proctree` | Intake left names to apply; short, descriptive, no collision in `internal/` | S:55 R:85 A:80 D:65 |
| 2 | Confident | A process-tree walk error counts as "agent alive" | No evidence must not fabricate an exit (fab's `has_agent: null` posture) | S:55 R:85 A:80 D:75 |
| 3 | Confident | Notice kinds `probe_error`, `skipped`, `gh_unavailable` with `{id, kind, error, failures}` | Intake listed the three notice cases without a schema; mirrors delta naming | S:50 R:85 A:75 D:65 |
| 4 | Confident | Agent-state duration formatted like `sessions.FormatAgentDuration`, reusing it if importable without a cycle, else a local equivalent | `operator` must not import `sessions`; behavior parity matters more than the call site | S:50 R:85 A:70 D:65 |
| 5 | Certain | Verification is `go vet`/`go test`/`go build` (+ darwin cross-build); no daemon start/restart | Plan Rule 1 and the user's instruction; change is backend/CLI only | S:90 R:90 A:90 D:90 |

| 6 | Confident | The `agent_state` delta is the report of the `agent:waiting`/`agent:idle` condition itself (new when its key is not in `reported`, open otherwise; an open row carries no `from`) rather than a separate event beside it | One delta per condition avoids reporting the same transition twice; the transition semantics (into waiting/idle only, silent for active/unknown) fall out of the key set | S:60 R:80 A:80 D:65 |
| 7 | Confident | `internal/proctree` receives the agent-name set from `cmd/rk` at init (`SetAgentCommNames`); the agent setup registry stays in `cmd/rk` | The registry is package-main code with installer logic; moving it is out of scope and `rk` is the only binary that runs the walk | S:55 R:85 A:80 D:60 |
| 8 | Confident | The process-tree walk (agent_exited) and the `git branch --show-current` lookups run in phase 1; phase 2 only reads their results | Neither may run under the state lock (a darwin walk spawns `ps`, git can take 10 s); branch lookups are limited to panes whose change lacks a branch_map entry | S:60 R:80 A:80 D:70 |
| 9 | Confident | One `unknown_dep:<id>` condition per missing dependency (fab emitted one row per item) | The key set is per dependency id, so each missing id reports and clears independently | S:60 R:85 A:75 D:70 |
| 10 | Confident | A user-paused pane item still runs the pane diff (baselines and events as in fab) but yields no conditions; a done item stays inert | R6 pins the paused condition set; skipping the diff would let baselines drift and fire a burst on resume | S:50 R:80 A:70 D:60 |
| 11 | Confident | `checked_at` of a completed probe is its completion time; every failure emits a `probe_error` notice, including the capping one that also yields the gating `paused` condition | A probe can run for seconds, and R4 lists the notice for every failure | S:55 R:85 A:75 D:65 |
| 12 | Confident | A dead tmux server (empty session list that fails `ServerAlive`) is a `Check` error, not an empty snapshot | An empty snapshot would report `pane_death` for every tracked pane and launch a paid run; mirrors `rk mux panes` | S:65 R:80 A:80 D:75 |
| 13 | Certain | The listed `panePIDsFn` seam is not created: pane pids come from the same listing as every other pane field | R2 of the plan: no second tmux call | S:80 R:90 A:90 D:85 |
| 14 | Confident | Human header is `no change` / `changed <n>` followed by `, open <n>` and `, notices <n>` when non-zero; rows are tab-aligned `<new\|open\|note>  <id>  <kind>  <detail>` | R10 example; tabwriter keeps columns aligned for any id length | S:60 R:90 A:80 D:70 |

14 assumptions (3 certain, 11 confident, 0 tentative).
