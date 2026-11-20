---
type: memory
description: "The operator loop runner (`internal/operatorloop`) behind the cron `run: operator-loop` entry: decision order (busy gate → `operator.Check` → run), the `_rk-operator` run window, run records (newest 50) and per-fire check records (newest 200), the `rk operator run-exec` wrapper (mechanical pass, judgment set, brief, failure notes, one push per failure streak), exactly-once transcription with the fire reason, launcher resolution, restart survival."
---
# Operator Loop

**Domain**: run-kit

## Overview

The operator loop is the daemon's scheduled operator: a cron entry of kind `run: operator-loop` ([cron](/run-kit/cron.md) § Operator Loop Entry) fires `operatorloop.Run`, which probes the tracked ledger for free with `operator.Check` ([operator-state](/run-kit/operator-state.md)) and only on a real change launches a run in its own tmux window. The run's wrapper first performs the mechanical autopilot pass ([operator-autopilot](/run-kit/operator-autopilot.md)) and starts a model only when a judgment set remains, handing it the rendered brief on stdin ([operator-brief](/run-kit/operator-brief.md)). Each run leaves durable records, and the cron tick transcribes finished records into the delivery log, so a fresh daemon rebuilds every outcome from files and tmux alone (Constitution II) and a run never depends on the daemon that started it (Constitution VI). `internal/operatorloop` imports `cron`, `operator`, `tmux`, and `riff`; `cron` holds only the nil-safe seams, which `cmd/rk/cron_operator_loop.go` (`wireOperatorLoop`, called from `serve.go`) fills with `Run`, `Transcribe`, `MarkLogged`, and `StateFileExists`.

## Requirements

### Requirement: Runner decision order

For a due loop fire on server S, `Run` SHALL decide in this order and stop at the first match:

1. An invalid server name ⇒ `check-failed: <message>`.
2. A live run window on S (§ In-flight definition) ⇒ `skipped-busy: run <run-id>`, with `operator.Check` NOT called — the run in flight owns the current changes, and the state file's `last_check_at` stays untouched.
3. `operator.Check(ctx, S, CheckOptions{})` — an error ⇒ `check-failed: <first line of the error>`; `Changed == false` ⇒ `no change`, and no window or run record is created (the fire's check record is — § Check records).
4. Otherwise map `CheckResult.Changes` to `[]operator.ChangedItem` (one per id in first-seen order, reasons accumulated as `<kind>[ <detail>]`, with a detail only where the delta carries a short one — a stage or agent-state move, the changed field names, an age, the paused error, the missing dependency), persist the run record (the changed items with their reasons, the fire's reason, and the fire's id as the run id), open the run window, and return a `Held` outcome — no log line at launch; the single line for the fire is written at transcription.

The daemon renders no brief: the wrapper renders it after the mechanical pass, only when judgment is needed. A failure while preparing a run that left nothing on disk is logged at once as `run-lost: launch: <err>`. A failure after the record exists marks the record ended with a `lost` reason of `launch: <err>`, and transcription logs the same line. Every launch failure also appends a `run failed: launch: <err>` note (`--by run`) to each changed item, because the check already consumed those items' edges and the note is what keeps the failure visible. Probes cost nothing, so the loop opens a run window only when `Check` reports a change, and the run spends a model call only when judgment is needed.

#### Scenario: Busy fire does not probe
- **GIVEN** a live run window on S
- **WHEN** the loop entry fires
- **THEN** the outcome is `skipped-busy: run <id>` and `last_check_at` is unchanged

#### Scenario: Quiet fire costs nothing
- **GIVEN** no run window and a `Check` reporting no new changes
- **WHEN** the entry fires
- **THEN** the outcome is `no change`, and no window or record exists afterward

### Requirement: Run window

A run SHALL execute in a window of the `_rk-operator` session on S, named `run-<short-id>` (the run id's random suffix), created detached, with cwd `@rk_srv_operator_root` while it still validates as an absolute directory, else the home directory (the `rk operator -L` rule). The window runs the hidden wrapper verb directly — no `; exec $SHELL` tail — so the window dies when the wrapper exits. All tmux interaction goes through `internal/tmux` argv-slice helpers under `TmuxTimeout` (`LaunchOperatorRunWindow`); `internal/operatorloop` and `cmd/rk` build no tmux commands inline.

- **One-invocation create + stamp.** The `new-window -d -P` that creates the window is chained with the `set-option -w` calls that stamp `@rk_win_role=operator-run` and `@rk_win_operator_run=<run-id>` and pin `remain-on-exit off`, each targeting the new window by its unique name — so a daemon crash between create and stamp cannot leave an unstamped running wrapper, and no reader ever sees an unstamped run window. A failed invocation kills any window of that name (on a fresh context bound, since the create may have finished server-side after the client gave up), so no unstamped window survives.
- **Detached.** A client attached to `_rk-operator` (viewing the chat window) is never switched to background work.
- **Placeholder handling.** When the launch creates `_rk-operator` itself, tmux's placeholder default-shell window is killed once the run window exists (the shared placeholder-capturing ensure helper — [tmux-sessions](/run-kit/tmux-sessions.md) § Operator Session), so the session holds only run windows and stays hidden. An adopted pre-existing session keeps its windows.
- **`remain-on-exit off`.** A user's global `remain-on-exit on` cannot leave a dead run window behind.

#### Scenario: First run on a server with no operator session
- **GIVEN** a server with no `_rk-operator` session
- **WHEN** a run launches
- **THEN** `_rk-operator` exists with one window `run-<short-id>` carrying both stamps, and the session is hidden from user-facing lists

### Requirement: In-flight definition

A run counts as in flight — for the runner's busy gate, the evaluator's `RunInFlight` fact, and transcription's window lookup alike — only when a window carries BOTH `@rk_win_role=operator-run` AND a non-empty, valid `@rk_win_operator_run` (`validate.ValidRunID`) AND at least one pane with `#{pane_dead}` = 0. One shared filter (`tmux.ListOperatorRunWindows`, a single `list-panes -a`) backs all three, so a role-only window or a dead husk kept by a user's `remain-on-exit on` never pins the loop as busy.

#### Scenario: Role without a run id
- **GIVEN** a window carrying `@rk_win_role=operator-run` but no `@rk_win_operator_run`
- **WHEN** the tick gathers facts
- **THEN** `RunInFlight` is false

#### Scenario: A user keeps dead panes
- **GIVEN** a user config with `set -g remain-on-exit on`
- **WHEN** a run's wrapper exits
- **THEN** the run window is gone, or if a dead window remains it does not count as in flight, and the next loop fire is not suppressed

### Requirement: Run records, brief, and log

Per run, under `<state home>/operator/runs/<slug>/` (dir 0700, files 0600; `<slug>` is the operator state-file slug for S), up to three files exist: `<run-id>.json` (the record), `<run-id>.brief.md` (the rendered brief, present only for a run that reached a model), and `<run-id>.log` (the wrapper's header line and tee'd launcher output, plus the self-log records of every `rk` the run invokes — § The `rk operator run-exec` wrapper). The run id is `YYYYMMDDTHHMMSS-xxxx` (UTC time, four random `[a-z0-9]`), so ids sort chronologically. The record is `{id, server, entry, fired_at, reason, changed, changes, pass, window, started_at, ended_at, exit_code, outcome, lost, transcript, logged}` with RFC3339 UTC timestamps and zero values omitted; `changed` is the item ids and `changes` is `[{id, reasons}]` with the check's reason strings; `pass` is `{actions, escalations, busy, error}` from the mechanical phase; `exit_code` is a pointer so a real `0` is recorded and "not exited" stays absent; `lost` is the reason a run never produced an exit status; `reason` is the fire's reason (`schedule`, `wake`, or `trigger:<why>` — [cron](/run-kit/cron.md) § Operator Loop Entry), and a record without one reads as a `schedule` fire. The `transcript` field is never populated for headless runs — the launcher is provider-opaque and nothing in the exit contract carries a session reference — and exists, with its API and UI plumbing, for a launcher that reports one.

- The record is written atomically (`fsatomic`) BEFORE the window is created: durable before acknowledged. The brief file is written by the wrapper, after the pass.
- Path resolution uses one tmux socket-path query and fails when the socket path is unknown, with no fallback to the `default` slug, so a transient query failure cannot move run files, failure notes, or seeding onto another server's files. Server names and run ids are validated before they reach any path or tmux argv; the slug is checked as a path component.
- The daemon (launch, marking lost, marking logged) and the wrapper (start, `pass`, brief, end) write whole files atomically through read-modify-write, each changing only its own fields; they never write the same phase of a run.
- **Retention.** Transcription prunes each server to the newest 50 records, deleting record, brief, and log together — except a record not yet `logged`, which is history the delivery log has not received yet. Check records are pruned by the same pass, independently (§ Check records).

### Requirement: Check records

Every fire on which `operator.Check` returned a result SHALL persist `<fire-id>.check.json` in the run directory beside the run records (dir 0700, file 0600, written atomically) — a `no change` fire and a changed fire alike, whether or not the launch then succeeds. The record is `{fired_at, reason, checked_at, changed, changes, open, notices}` plus `run`, present only when the fire persisted a run record; `changes`, `open` and `notices` are `operator.CheckResult`'s slices marshalled as-is (the pinned `CheckDelta` JSON) and always arrays. The fire id is generated per fire in the run-id format (`NewRunID`), and a fire that launches a run uses it as the run id, so `<id>.check.json` sits beside `<id>.json`, `<id>.brief.md` and `<id>.log`. A `skipped-busy` fire (no check ran) and a `check-failed` fire (the check errored; its log line carries the error) write none. A write failure is a warning and never changes the fire's outcome. Retention is the newest `CheckRetention` (200) per server, pruned by the same `Prune` pass `Transcribe` calls and independent of the run retention of 50; a check record never counts toward, nor is deleted with, a run record. The two kinds list through one suffix-parameterized lister over run-id-shaped stems; a run listing ignores `<id>.check.json` because its stem `<id>.check` is not a run id.

#### Scenario: A quiet fire leaves its record
- **GIVEN** a fire whose check reports no change
- **WHEN** `Run` returns `no change`
- **THEN** one `<id>.check.json` exists with `changed: false`, the fire's reason, and no `run` key
- **AND** a changed fire's record carries `run: <id>` equal to its run record's id

#### Scenario: Retention
- **GIVEN** 205 check records in a run directory
- **WHEN** `Prune` runs
- **THEN** the 200 newest remain and run records are untouched

### Requirement: The `rk operator run-exec` wrapper

`rk operator run-exec --server S --run <run-id> -- <launcher argv…>` (hidden; `cmd/rk/operator_run_exec.go`, body in `operatorloop.Exec`; excluded from the MCP policy table) runs inside the run window, so the wrapper — not the daemon — is the run's parent and the only writer of the run's end state. It SHALL:

1. Record `started_at`, before anything that can fail.
2. Run the **mechanical phase** (below) through the `ExecOptions.Pass` seam, wired in `cmd/rk` to `autopilot.Step` with the production Env (the same Runner/Spawner/Panes/Session/Notify wiring as the `autopilot` verbs). It records `pass: {actions, escalations, busy, error}` in the run record. A `busy` pass (another process holds the pass lock) is recorded and the wrapper continues without waiting; a pass error is recorded in `pass.error` and the wrapper continues.
3. Compute the **judgment set**. When it is empty, end the run with outcome `mechanical · <n> actions` (n = the pass's actions) and exit code 0, with no launcher started and no model called. Otherwise render the brief and run the launcher.
4. Write one header line to the run log and the window, then run the launcher (`exec.CommandContext`, its own process group so a ceiling or a killed window stops the whole tree) with stdin read from the brief file and stdout/stderr tee'd to the window and to the run log. A 2-hour ceiling (`ExecCeiling`) bounds a hung provider; SIGTERM, SIGHUP, and SIGINT (the window being killed) stop the child and are recorded like any other end.
5. Take the LAST complete stdout line matching `^outcome: (.*)$` as the run's outcome.
6. On a non-zero exit or no outcome line: append `run failed: exit <n> — <≤200-byte whitespace-collapsed log tail>` with `--by run` to each `changed` item still in the ledger (removed items are skipped silently, one failure never stops the rest), and — once per failure streak — send a fail-silent push titled `operator run failed` (best-effort — a push error never changes the run's recorded end). The note is written on every failure; the push is sent only when the newest own line of the run's loop entry in the server's cron log is not itself a failure (`cron.IsLoopFailureOutcome`). The wrapper reads that log read-only through a test seam — the current run's own line is not in it yet (the tick writes it at transcription, and the evaluator suppresses the loop entry while a run window lives), so the newest own line is the preceding fire's — and an empty or unreadable log counts as no streak, so a failure fails toward notifying.
7. Record `ended_at`, `exit_code`, and `outcome`.

**Mechanical phase.** The phase reads the record, runs the pass, loads the ledger fresh and computes the judgment set from the record's `changes`, the pass result and the ledger. It records `pass` before deciding. Any other failure of the phase — a record read, the ledger load, the brief write, the record update, or building the production Env — records the run end (non-zero exit code, empty outcome) and takes the same failure path as a failed launcher (`run failed` note on each changed item plus the once-per-streak push); the start was already recorded.

**Judgment set.** `judgmentSet` is a pure, table-tested function over the changes, the pass result, the ledger and the set of engine-owned ids. An item is judgment when:

- one of its changed reasons is an `agent_state` move to `waiting` or `idle`, an `agent_aged` (rendered `agent_aged <state> <duration>`), `due`, `stale`, `paused`, `unknown_dep`, `note` (rendered `note <at>`: an unanswered user or chat instruction), a `changed` probe delta on a `github-pr` item, a `done` on a `github-pr` item (merged or closed) or on any item with a non-empty `then`, or a pane condition (`pane_death`, `pane_mismatch`, `agent_exited`) on an item whose id is not in the engine file; or
- the pass escalated it; or
- the ledger item carries an unanswered instruction (`operator.PendingInstruction` — [operator-state](/run-kit/operator-state.md) § Conditions) whose `note` condition an earlier fire already reported, so this run's change records do not carry it; the scan lists the item once, never beside a `note` reason it already has.

`stage_advance`, `review_fail`, a `changed` probe delta on a non-PR item, a queue item's `pane_death`, and a `done` on a non-PR item without `then` are never judgment: the engine handles them or they need no action. The engine owns queue items only, so a `github-pr` item — including a PR the engine never tracks — reaches the run through its `changed` and `done` deltas. An escalation the engine already notified once does not re-enter the set on later passes, because its escalate-once row waits.

**Brief after the pass.** For a non-empty judgment set the wrapper renders `operator.RenderBrief` from a fresh ledger load with the judgment set as the changed list, writes it to the run's brief path, and runs the launcher as above; the brief therefore reflects the pass's notes and projections.

**Launcher environment.** The launcher's `cmd.Env` is the wrapper's environment (`tmux.ChildEnv`) with `$TMUX` restored from `tmux.OriginalTMUX` — `internal/tmux`'s `init()` strips `$TMUX` from every rk process, so without the restore a bare `rk`, `fab`, or `tmux` call in the run resolves to the `default` server — plus `RK_OPERATOR_RUN_LOG=<absolute path of <run-id>.log>` (`operatorloop.RunLogEnv`). The brief additionally names the server with `-L` on every command ([operator-brief](/run-kit/operator-brief.md) § Embedded run rules), so a run does not depend on the ambient `$TMUX`.

**Header line.** Before the launcher starts the wrapper writes `run-exec: server=<server> run=<run-id> tmux=<socket|unset> cwd=<cwd> launcher=<shell-quoted argv>` (server rendered through `operator.ServerLabel`; `tmux=` is the restored `$TMUX` up to its first comma, else `unset`). When `$TMUX` is set and its socket basename differs from the server label, the line ends ` WARNING: TMUX socket does not match --server`; the mismatch is not fatal. The header is not an `outcome:` line and takes no part in outcome capture or the failure contract.

**Run-log self-log.** When `RK_OPERATOR_RUN_LOG` holds an absolute path, every `rk` process the run starts appends one record to it as it exits ([cli](/run-kit/architecture/cli.md) § Run-log self-log), so a failing tool call is diagnosable from the run log alone — the launcher is provider-opaque and its own log holds only its final message. The `run failed` note's ≤200-byte log tail may therefore show the last record.

The wrapper never writes the cron log. Its exit status mirrors the child's (124 on the ceiling, 127 on a failure to start, 128+signal when signalled).

#### Scenario: Clean run
- **GIVEN** a launcher that prints `outcome: stub acted` and exits 0
- **WHEN** the wrapper finishes
- **THEN** the record carries `exit_code: 0`, `outcome: "stub acted"`, and `ended_at`, and no failure note was written

#### Scenario: Run on a non-default server
- **GIVEN** the wrapper started inside a window on server `loom` (`$TMUX` names `/tmp/tmux-1000/loom`)
- **WHEN** the launcher runs
- **THEN** its environment carries that `$TMUX` and `RK_OPERATOR_RUN_LOG`, and the log's first line is `run-exec: server=loom … tmux=/tmp/tmux-1000/loom …` with no warning

#### Scenario: Failing run
- **GIVEN** a launcher that exits 1 with no outcome line
- **WHEN** the wrapper finishes
- **THEN** each changed item gains a `by: run` note starting `run failed: exit 1`, and the record carries `exit_code: 1`

### Requirement: Exactly-once transcription

`Transcribe(ctx, S)` returns one `cron.LogLine` (entry = the record's entry, `run` = id, reason = the record's `reason`, `schedule` when the record has none) per record that is ended and not `logged`, oldest first:

| Record | Line |
|---|---|
| `lost` set | `run-lost: <reason>` |
| `exit_code == 0` and an outcome | `ran · <outcome> · <duration>` (a mechanical run reads `ran · mechanical · <n> actions · <duration>`) |
| `exit_code != 0` | `run-failed: exit <n> · <duration>` |
| ended, no outcome line | `run-failed: no outcome line · <duration>` |

The duration is `ended_at − started_at`, falling back to `ended_at − fired_at` when the wrapper never recorded a start. A record with no `ended_at` whose window (matched by `@rk_win_operator_run`) no longer exists is marked ended with `lost: window gone` and transcribed as `run-lost: window gone`; if the window listing itself fails, no run is judged lost that tick; marking lost sets `lost` only while the re-read record still has no `ended_at`, so a wrapper that recorded a clean end between the read and the write is never rewritten as lost. An unparseable record is skipped with a warning, never failing the tick. After appending a line the tick calls `MarkLogged`, and a run id already present in the log is marked without a second line, so a crash between append and mark still yields exactly one line. Transcription then prunes (§ Run records, brief, and log); mechanical runs count toward the newest-50 retention. The Operator Tasks drawer and cron log render the mechanical line and `escalated: …` notes through their existing row rendering.

#### Scenario: A trigger-launched run keeps its reason
- **GIVEN** a run launched by a `trigger:note` fire
- **WHEN** its record is transcribed
- **THEN** the cron log line has `reason: "trigger:note"`, and a record with no `reason` transcribes with `reason: "schedule"`

#### Scenario: Restart mid-run
- **GIVEN** the daemon was killed mid-run and the wrapper recorded `ended_at` while it was down
- **WHEN** a fresh daemon's first tick runs
- **THEN** exactly one `ran · … · …` line is appended and the record reads `logged: true`, and the next tick appends nothing for it

### Requirement: Launcher resolution

The daemon SHALL resolve the run launcher with `riff.ResolveHeadlessAgent(ctx, <run window cwd>, "operator")` — `fab agent operator --headless -o yaml` under `FabTimeout`, tolerant top-level `command` extraction as `ResolveAgent` does, no legacy `--print` retry — falling back to `riff.DefaultHeadlessLauncher` (`claude -p --dangerously-skip-permissions`) on any failure (fab absent, non-zero exit, timeout, no command). The launcher string is run as `sh -c '<launcher>'` — the one documented shell-expansion exception to the argv-slice rule — with the brief on stdin; the wrapper itself is invoked through `selfpath.Stable`, the running executable's stable path, never the launcher-or-stable variant. The brief's allowed-tool list stays declarative: the launcher is provider-opaque, so nothing restricts a run's tools at launch.

#### Scenario: fab absent
- **GIVEN** fab is not on PATH
- **WHEN** a run launches
- **THEN** the wrapper argv ends `-- sh -c 'claude -p --dangerously-skip-permissions'`

### Requirement: Restart-survival invariants

Every daemon-originated write is durable before a run launches, and the daemon holds no run state in memory. A fresh daemon rebuilds from three sources alone: the run records (outcome, exit, `logged`), the cron delivery log (ladder position, dedupe by run id), and tmux (the stamped run windows — the in-flight signal). A run survives its daemon because the wrapper lives in a tmux window; a run whose window vanished is reported once as `run-lost: window gone`. Run windows are never captured by layout snapshots and a restore never re-stamps the role ([layout-snapshots](/run-kit/layout-snapshots.md) § Capture set), so a restored shell window cannot read as a run in flight forever. A Go integration test on an isolated tmux socket directory (the test binary re-exec'd as the window's wrapper) launches a stub run through the runner and wrapper, drops all in-memory daemon state, and asserts one `ran · stub acted · …` line plus the item note after a fresh tick, and a mechanical-only run (a changed set the engine fully handles) that exits without invoking the stub launcher and leaves one `ran · mechanical · … actions · …` line; it never touches the live daemon or a user's tmux server.

## Design Decisions

### Probe before spend
**Decision**: The loop runs `operator.Check` on every fire and launches a model run only when it reports a change; a busy fire skips the check entirely.
**Why**: Checks are deterministic and free, a run is a paid model call, and a check consumes the edges it reports — so a check performed while a run is in flight would swallow changes that run is already handling or about to be told about.
**Rejected**: Launching a run per fire; checking while busy and queueing the result (edges consumed with no run to act on them).
*Introduced by*: 261112-xxvq-operator-loop-check-run-note

### Mechanical pass in the wrapper, model only for judgment
**Decision**: The `rk operator run-exec` wrapper runs `autopilot.Step` before any launcher and launches a model only when the judgment set is non-empty.
**Why**: A tick costs a model call only when judgment is needed; the wrapper already lives in a restart-surviving tmux window, owns the run's end state and can take minutes without blocking the daemon tick.
**Rejected**: Running the pass in the daemon tick (blocks the tick under tmux's timeout budget); prose-driven model runs for mechanical work.
*Introduced by*: 261116-rxic-autopilot-own-state-mechanical-runs

### The brief is rendered after the pass
**Decision**: The daemon persists the record with structured changes and reasons; the wrapper renders the brief from a fresh ledger load and the judgment set.
**Why**: A brief rendered before the pass would describe items the pass is about to change and list items needing no judgment; rendering afterwards shows the notes and projections the pass just wrote and only the items that need a model.
**Rejected**: Rendering in the daemon and re-rendering after the pass (two renders, one stale); passing the pass result to a launcher-side renderer.
*Introduced by*: 261116-rxic-autopilot-own-state-mechanical-runs

### Wrapper in the window, not a daemon child
**Decision**: The run is the hidden `rk operator run-exec` wrapper executing inside its own tmux window, which writes the run's start and end into the record.
**Why**: tmux holds the process across a daemon restart (Constitution VI), the wrapper is the only party that knows when the child exits, and the record it leaves is all a fresh daemon needs.
**Rejected**: The daemon spawning and awaiting the launcher (the run dies or is orphaned with the daemon); the wrapper writing the cron log directly (see the single-writer decision in [cron](/run-kit/cron.md)).
*Introduced by*: 261112-xxvq-operator-loop-check-run-note

### Busy is defined by live, stamped, valid run windows
**Decision**: In flight means role `operator-run` plus a valid run id plus a live pane, created with `remain-on-exit off`, with create-and-stamp in one tmux invocation, and never captured or re-stamped by snapshots.
**Why**: A busy signal that outlives its run silently disables the loop forever: a user's `remain-on-exit on` leaves a dead husk, a restore re-stamps the role onto a fresh shell, and a crash between create and stamp strands an unstamped wrapper.
**Rejected**: Treating any `operator-run`-role window as busy; stamping after creation; capturing run windows as inert history.
*Introduced by*: 261112-xxvq-operator-loop-check-run-note

### The run launcher keeps its tmux server
**Decision**: The wrapper hands the launcher its own captured `$TMUX` (via `tmux.ChildEnv`) and exports `RK_OPERATOR_RUN_LOG`; the brief also renders `-L <server>` on every server-addressed command.
**Why**: `internal/tmux`'s `init()` strips `$TMUX` process-wide, so a child of any rk binary loses its server unless it is restored, and every bare tmux/rk/fab call in the run then targets `default` — it cannot capture panes and reads another server's ledger while still exiting 0. The restore fixes bare commands, including tools rk does not own; the explicit `-L` keeps a later environment regression from silently retargeting a run.
**Rejected**: Brief `-L` alone (bare `fab` and `tmux` calls still need `$TMUX`); env restore alone (one regression from the same silent failure).
*Introduced by*: 261114-qxos-operator-run-explicit-server

### rk self-logs into the run log
**Decision**: Diagnostics come from rk itself — each rk invocation inside a run appends its argv, exit code, error, and capped streams to the run log — not from rendering the launcher's output.
**Why**: Provider-neutral and deterministic: the run's tools are mostly rk verbs, and a plain headless launcher's log holds only its final prose.
**Rejected**: Stream-json rendering for Claude launchers (Claude-only, breaks the provider-opaque launcher rule); a brief rule to quote errors (depends on model compliance).
*Introduced by*: 261114-qxos-operator-run-explicit-server

### Failure notes at the wrapper and launch, because the check consumed the edges
**Decision**: A failed launch, a failed mechanical phase and a failed run (non-zero exit or no outcome line) each append a `--by run` failure note (`operator.FailureNotePrefix` + detail) to each changed item, and `PendingInstruction` skips those notes, so a failure never answers an instruction.
**Why**: `Check` is edge-triggered and has already recorded the changes as reported, so without a note a failed run would be invisible until the condition changed again. A run that failed before acting has not read the user's note, so the instruction must stay pending for the next run that actually starts.
**Rejected**: Relying on the log line and the push alone (the item's own notes are what the next run and the drawer read); letting a failure note clear a pending instruction (the instruction would be silently dropped).
*Introduced by*: 261112-xxvq-operator-loop-check-run-note

### Push once per failure streak by reading the cron log
**Decision**: The wrapper skips the failed-run push when the loop entry's newest own cron log line is already a failure; the failure note is written regardless.
**Why**: The log already holds the streak, so there is no second file to keep in sync, and a dead launcher backs off on the ladder instead of notifying every fire. An unreadable log pushes: a missed alert costs more than a repeated one.
**Rejected**: A streak marker beside the run records (a second source of truth).
*Introduced by*: 261120-pgns-operator-trigger-door-failure-streaks

### A check record per fire, shared id with the run
**Decision**: Every fire whose check ran persists `<fire-id>.check.json`, and a launched run reuses the fire id as its run id.
**Why**: The check's changes, open conditions and notices otherwise exist only in memory for a `no change` fire; persisting them lets a reader explain why a fire did nothing, and the shared id makes joining a check to its run trivial. A separate suffix and retention keep run-record listing, pruning and transcription unchanged.
**Rejected**: Recording only changed fires (a `no change` row would be unexplainable); a check section inside the run record (a quiet fire has no run record).
*Introduced by*: 261120-pgns-operator-trigger-door-failure-streaks
