---
type: memory
description: "The operator loop runner (`internal/operatorloop`) behind the cron `run: operator-loop` entry — decision order (busy gate → `operator.Check` → run), the `_rk-operator` run window, run records/brief/log under `<state>/operator/runs/<slug>/` with newest-50 retention, the hidden `rk operator run-exec` wrapper and its failure-note contract, exactly-once transcription, launcher resolution, and the restart-survival invariants."
---
# Operator Loop

**Domain**: run-kit

## Overview

The operator loop is the daemon's scheduled operator: a cron entry of kind `run: operator-loop` ([cron](/run-kit/cron.md) § Operator Loop Entry) fires `operatorloop.Run`, which probes the tracked ledger for free with `operator.Check` ([operator-state](/run-kit/operator-state.md)) and only on a real change launches a one-shot headless run in its own tmux window, handing it the rendered brief on stdin ([operator-brief](/run-kit/operator-brief.md)). Each run leaves durable records, and the cron tick transcribes finished records into the delivery log, so a fresh daemon rebuilds every outcome from files and tmux alone (Constitution II) and a run never depends on the daemon that started it (Constitution VI). `internal/operatorloop` imports `cron`, `operator`, `tmux`, and `riff`; `cron` holds only the nil-safe seams, which `cmd/rk/cron_operator_loop.go` (`wireOperatorLoop`, called from `serve.go`) fills with `Run`, `Transcribe`, `MarkLogged`, and `StateFileExists`.

## Requirements

### Requirement: Runner decision order

For a due loop fire on server S, `Run` SHALL decide in this order and stop at the first match:

1. An invalid server name ⇒ `check-failed: <message>`.
2. A live run window on S (§ In-flight definition) ⇒ `skipped-busy: run <run-id>`, with `operator.Check` NOT called — the run in flight owns the current changes, and the state file's `last_check_at` stays untouched.
3. `operator.Check(ctx, S, CheckOptions{})` — an error ⇒ `check-failed: <first line of the error>`; `Changed == false` ⇒ `no change`, and no window or run record is created.
4. Otherwise map `CheckResult.Changes` to `[]operator.ChangedItem` (one per id in first-seen order, reasons accumulated as `<kind>[ <detail>]`, with a detail only where the delta carries a short one — a stage or agent-state move, the changed field names, an age, the paused error, the missing dependency), render the brief with `operator.RenderBrief`, persist the run, open the run window, and return a `Held` outcome — no log line at launch; the single line for the fire is written at transcription.

A failure while preparing a run that left nothing on disk is logged at once as `run-lost: launch: <err>`. A failure after the record exists marks the record ended with a `lost` reason of `launch: <err>`, and transcription logs the same line. Every launch failure also appends a `run failed: launch: <err>` note (`--by run`) to each changed item, because the check already consumed those items' edges and the note is what keeps the failure visible. Probes cost nothing, so the loop spends a model run only when `Check` reports a change.

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

Per run, under `<state home>/operator/runs/<slug>/` (dir 0700, files 0600; `<slug>` is the operator state-file slug for S), three files exist: `<run-id>.json` (the record), `<run-id>.brief.md` (the rendered brief), and `<run-id>.log` (the wrapper's tee'd output). The run id is `YYYYMMDDTHHMMSS-xxxx` (UTC time, four random `[a-z0-9]`), so ids sort chronologically. The record is `{id, server, entry, fired_at, changed, window, started_at, ended_at, exit_code, outcome, lost, transcript, logged}` with RFC3339 UTC timestamps and zero values omitted; `exit_code` is a pointer so a real `0` is recorded and "not exited" stays absent; `lost` is the reason a run never produced an exit status. The `transcript` field is never populated for headless runs — the launcher is provider-opaque and nothing in the exit contract carries a session reference — and exists, with its API and UI plumbing, for a launcher that reports one.

- The record and brief are written atomically (`fsatomic`) BEFORE the window is created: durable before acknowledged.
- Path resolution uses one tmux socket-path query and fails when the socket path is unknown, with no fallback to the `default` slug, so a transient query failure cannot move run files, failure notes, or seeding onto another server's files. Server names and run ids are validated before they reach any path or tmux argv; the slug is checked as a path component.
- The daemon (launch, marking lost, marking logged) and the wrapper (start, end) write whole files atomically through read-modify-write, each changing only its own fields; they never write the same phase of a run.
- **Retention.** Transcription prunes each server to the newest 50 records, deleting record, brief, and log together — except a record not yet `logged`, which is history the delivery log has not received yet.

### Requirement: The `rk operator run-exec` wrapper

`rk operator run-exec --server S --run <run-id> -- <launcher argv…>` (hidden; `cmd/rk/operator_run_exec.go`, body in `operatorloop.Exec`; excluded from the MCP policy table) runs inside the run window, so the wrapper — not the daemon — is the run's parent and the only writer of the run's end state. It SHALL:

1. Record `started_at`.
2. Run the launcher (`exec.CommandContext`, its own process group so a ceiling or a killed window stops the whole tree) with stdin read from the brief file and stdout/stderr tee'd to the window and to the run log. A 2-hour ceiling (`ExecCeiling`) bounds a hung provider; SIGTERM, SIGHUP, and SIGINT (the window being killed) stop the child and are recorded like any other end.
3. Take the LAST complete stdout line matching `^outcome: (.*)$` as the run's outcome.
4. On a non-zero exit or no outcome line: append `run failed: exit <n> — <≤200-byte whitespace-collapsed log tail>` with `--by run` to each `changed` item still in the ledger (removed items are skipped silently, one failure never stops the rest), and send a fail-silent push titled `operator run failed` (best-effort — a push error never changes the run's recorded end).
5. Record `ended_at`, `exit_code`, and `outcome`.

The wrapper never writes the cron log. Its exit status mirrors the child's (124 on the ceiling, 127 on a failure to start, 128+signal when signalled).

#### Scenario: Clean run
- **GIVEN** a launcher that prints `outcome: stub acted` and exits 0
- **WHEN** the wrapper finishes
- **THEN** the record carries `exit_code: 0`, `outcome: "stub acted"`, and `ended_at`, and no failure note was written

#### Scenario: Failing run
- **GIVEN** a launcher that exits 1 with no outcome line
- **WHEN** the wrapper finishes
- **THEN** each changed item gains a `by: run` note starting `run failed: exit 1`, and the record carries `exit_code: 1`

### Requirement: Exactly-once transcription

`Transcribe(ctx, S)` returns one `cron.LogLine` (entry = the record's entry, `run` = id, reason `schedule`) per record that is ended and not `logged`, oldest first:

| Record | Line |
|---|---|
| `lost` set | `run-lost: <reason>` |
| `exit_code == 0` and an outcome | `ran · <outcome> · <duration>` |
| `exit_code != 0` | `run-failed: exit <n> · <duration>` |
| ended, no outcome line | `run-failed: no outcome line · <duration>` |

The duration is `ended_at − started_at`, falling back to `ended_at − fired_at` when the wrapper never recorded a start. A record with no `ended_at` whose window (matched by `@rk_win_operator_run`) no longer exists is marked ended with `lost: window gone` and transcribed as `run-lost: window gone`; if the window listing itself fails, no run is judged lost that tick; marking lost sets `lost` only while the re-read record still has no `ended_at`, so a wrapper that recorded a clean end between the read and the write is never rewritten as lost. An unparseable record is skipped with a warning, never failing the tick. After appending a line the tick calls `MarkLogged`, and a run id already present in the log is marked without a second line, so a crash between append and mark still yields exactly one line. Transcription then prunes (§ Run records, brief, and log).

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

Every daemon-originated write is durable before a run launches, and the daemon holds no run state in memory. A fresh daemon rebuilds from three sources alone: the run records (outcome, exit, `logged`), the cron delivery log (ladder position, dedupe by run id), and tmux (the stamped run windows — the in-flight signal). A run survives its daemon because the wrapper lives in a tmux window; a run whose window vanished is reported once as `run-lost: window gone`. Run windows are never captured by layout snapshots and a restore never re-stamps the role ([layout-snapshots](/run-kit/layout-snapshots.md) § Capture set), so a restored shell window cannot read as a run in flight forever. A Go integration test on an isolated tmux socket directory (the test binary re-exec'd as the window's wrapper) launches a stub run through the runner and wrapper, drops all in-memory daemon state, and asserts one `ran · stub acted · …` line plus the item note after a fresh tick; it never touches the live daemon or a user's tmux server.

## Design Decisions

### Probe before spend
**Decision**: The loop runs `operator.Check` on every fire and launches a model run only when it reports a change; a busy fire skips the check entirely.
**Why**: Checks are deterministic and free, a run is a paid model call, and a check consumes the edges it reports — so a check performed while a run is in flight would swallow changes that run is already handling or about to be told about.
**Rejected**: Launching a run per fire; checking while busy and queueing the result (edges consumed with no run to act on them).
*Introduced by*: 261112-xxvq-operator-loop-check-run-note

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

### Failure notes at the wrapper and launch, because the check consumed the edges
**Decision**: Both a failed launch and a failed run (non-zero exit or no outcome line) append a `--by run` failure note to each changed item.
**Why**: `Check` is edge-triggered and has already recorded the changes as reported, so without a note a failed run would be invisible until the condition changed again.
**Rejected**: Relying on the log line and the push alone (the item's own notes are what the next run and the drawer read).
*Introduced by*: 261112-xxvq-operator-loop-check-run-note
