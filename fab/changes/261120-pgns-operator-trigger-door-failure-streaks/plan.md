# Plan: Operator Clock — Failure Streaks, Trigger Door, Check Records, Notes as Conditions

**Change**: 261120-pgns-operator-trigger-door-failure-streaks
**Intake**: `intake.md`

All source paths are relative to `app/backend/` unless they start with `docs/`.

## Requirements

### Cron: Failure-climbing ladder

#### R1: Failure outcomes climb the loop ladder
`cron.LoopLadder` SHALL count, in the trailing run of the loop entry's own log lines, every `no change` line **and** every failure-class line (`run-failed: …`, `run-lost: …`, `check-failed: …`), climbing one rung per line. Any other own line (`ran · …`, `skipped-busy: run …`, `rate-capped`, …) SHALL end the count. A single exported classifier (`cron.IsLoopFailureOutcome`) SHALL own the failure-class test. `DeriveEntry` and the operator watchdog SHALL follow through their existing `LoopLadder` calls.

- **GIVEN** a loop entry whose own log ends `ran · x · 1m`, `run-failed: exit 1 · 4s`, `check-failed: boom`, `no change`
- **WHEN** `LoopLadder` runs
- **THEN** the rung is 3 and the anchor is the last line's time
- **AND** a log ending `run-failed: …`, `skipped-busy: run r1` yields rung 0

### Operator loop: One push per failure streak

#### R2: The failed-run push fires once per streak
`reportFailure` (`internal/operatorloop/exec.go`) SHALL write the `run failed: …` note on every changed item on every failure (unchanged) and SHALL send the `operator run failed` push only when the newest own line of the run's loop entry (`rec.Entry`) in the server's cron log is not a failure (`cron.IsLoopFailureOutcome`). An empty or unreadable log SHALL push. The log is read only; the wrapper never writes it.

- **GIVEN** the newest own loop line is `run-failed: exit 1 · 3s`
- **WHEN** a run fails
- **THEN** the note is written and no push is sent
- **AND** with the newest own line `ran · ok · 1m` (or no log) the push is sent

### Cron: The trigger door

#### R3: Wake marker file
`internal/cron` SHALL provide `WakePath(dir, slug)` (`<dir>/<slug>.wake`, slug validated with `ValidSlug`), `WriteWakeMarker`, `ReadWakeMarker`, `RemoveWakeMarker`, and a reason normalizer shared by CLI and API. The marker SHALL be exactly one line `<unix-ts> <reason>\n`, written atomically (`fsatomic.WriteFile`) with mode `0600`; a later write overwrites (newest wins). The normalizer SHALL trim, map empty to `manual`, reject any control character (including newline) with an error, and reject reasons longer than 120 runes. A marker whose content does not parse SHALL read as present with reason `manual`. Removing an absent marker SHALL NOT be an error.

- **GIVEN** `WriteWakeMarker(dir, "work", "note", t)`
- **WHEN** the file is read back
- **THEN** it holds `"<t.Unix()> note\n"` with mode 0600 and `ReadWakeMarker` returns reason `note`, at `t.Unix()`
- **AND** a reason containing `\n` is rejected and no file is written

#### R4: `rk operator wake`
`rk operator wake [-L <server>] [--reason <text>] [--json]` SHALL resolve the server like the other `rk operator` verbs (`operatorServer`), validate the reason, write the marker under `cron.DefaultDir()` (ensuring the dir exists), print a one-line confirmation (or the JSON envelope `{server, reason}`), and exit 0. It SHALL need no daemon and SHALL NOT check server liveness. Exit 1 on a write failure, 2 on a usage error (bad reason, bad server name, extra args). Help text SHALL follow the `operator check` Long layout (Flags / Examples / Exit codes) and state that it is the door to make the operator look, never a bare `rk operator check`.

- **GIVEN** no daemon running
- **WHEN** `rk operator wake -L work` runs
- **THEN** `<cron dir>/work.wake` exists with reason `manual` and the command exits 0
- **AND** `--reason $'a\nb'` exits 2 without writing

#### R5: The tick consumes the marker and fires the loop with a trigger reason
For each **live** server, `tickServer` SHALL read the marker before `Evaluate` and pass its reason in `EvalInput`. `Evaluate` SHALL treat a pending trigger as making the loop entry due — after the muted check and the `RunInFlight` suppression, which still win — emitting one fire with `Reason: "trigger:<reason>"`, `Rung: 0`, `DueAt: now`; when the schedule or wake edge is also due, there is still one fire and the trigger reason wins. The tick SHALL delete the marker exactly when a trigger fire was emitted for the loop entry, before invoking the runner (so a crash mid-run cannot fire it twice), including when the fire is then rate-capped (the `rate-capped` line carries the trigger reason). The marker SHALL be left in place when the loop entry is muted, a run is in flight, or the server has no loop entry; a dead server's marker SHALL never be touched. A delete failure SHALL be a `wake-marker-remove-failed` diagnostic. The fire's log line SHALL carry `Reason: "trigger:<reason>"`.

- **GIVEN** a live server with a loop entry not otherwise due and a marker `… manual`
- **WHEN** the tick runs
- **THEN** the runner is called once with `fire.Reason == "trigger:manual"`, the logged line carries that reason, and the marker is gone
- **AND** a second tick with no new marker does not fire the trigger again

- **GIVEN** a marker on a server not in the live set, or a live server whose run window is alive, or whose loop entry is muted
- **WHEN** the tick runs
- **THEN** no trigger fire is emitted and the marker file is still present

#### R6: Fire reason reaches the run's transcribed line
`operatorloop.Record` SHALL gain `Reason string` (`json:"reason,omitempty"`) set from `fire.Reason` in `persistRun`. `Transcribe` SHALL emit `Reason: rec.Reason`, falling back to `string(cron.FireSchedule)` when empty.

- **GIVEN** a run launched by a `trigger:note` fire
- **WHEN** its record is transcribed
- **THEN** the cron log line has `reason: "trigger:note"`
- **AND** a record with no `reason` transcribes with `reason: "schedule"`

### API: Wake endpoint

#### R7: `POST /api/operator/wake`
The router SHALL register `POST /api/operator/wake` taking `{"server": "<name>", "reason": "<text>"}` (`reason` optional). The handler SHALL validate the server name (`validate.ValidateServerName`) and reason (R3 normalizer) — 400 with the repo's JSON error shape on failure — write the marker through the same `cron` helper before responding (durable before acknowledged), and respond 200 `{"server": …, "reason": …}`; a write failure is 500. Only POST is routed (Constitution IX). The cron dir SHALL be resolvable through a server seam for tests.

- **GIVEN** `POST /api/operator/wake {"server":"work"}`
- **WHEN** the handler runs
- **THEN** the marker exists with reason `manual` and the response is 200 `{"server":"work","reason":"manual"}`
- **AND** `{"server":"bad name!"}` returns 400 and writes nothing

### Operator loop: Check record per fire

#### R8: Every fire whose check ran persists a check record
`operatorloop.Run` SHALL, for every fire on which `operator.Check` returned a result (outcome `no change`, or changed regardless of whether the launch succeeds), write `<runs dir>/<fire-id>.check.json` (dir 0700, file 0600, atomic) with fields `fired_at`, `reason`, `checked_at`, `changed`, `changes`, `open`, `notices`, and `run` (only when a run record was persisted). `fire-id` SHALL use the run-id format; a fire that persists a run record SHALL use the same id for the run. `skipped-busy` and `check-failed` fires write none. A write failure SHALL be a `slog.Warn` and SHALL NOT change the fire's outcome. Check records SHALL be pruned to the newest `CheckRetention = 200` per server by the same `Prune` pass `Transcribe` already calls, independently of `RunRetention`.

- **GIVEN** a fire whose check reports no change
- **WHEN** `Run` returns `no change`
- **THEN** one `<id>.check.json` exists with `changed: false`, the fire's reason, and no `run` key
- **AND** a changed fire's record carries `run: <id>` equal to the run record's id

- **GIVEN** 205 check records in a runs dir
- **WHEN** `Prune` runs
- **THEN** the 200 newest remain and run records are untouched

### Operator state: Notes as conditions

#### R9: Unanswered user/chat note is a check condition
`operator.Check` SHALL derive, for every tracked item (including done and paused items), a condition keyed `note@<at>` when the item's newest `by: user` or `by: chat` note is strictly newer than its newest `by: run` note (or no run note exists), where `<at>` is that newest instruction note's `at`. Its delta SHALL be `Kind: "note"` with JSON `{"kind":"note","id":…,"at":…}`. Edge-triggering through `Reported` makes it a change once, open while unanswered, cleared by a newer run note, and a change again for a newer user/chat note. The "newest instruction newer than newest run note" rule SHALL have one owner in `internal/operator`, used by both the check and `operatorloop.judgmentSet`.

- **GIVEN** an item with a `by: user` note at T and no run note
- **WHEN** two checks run
- **THEN** the first reports `note` (id, at T) in `changes`, the second lists it in `open`
- **AND** after a `by: run` note at T+1 the condition is gone; a `by: chat` note at T+2 is a new change

#### R10: The note condition is a judgment reason
`reasonNeedsJudgment` SHALL return true for a `note` reason; `reasonFor` SHALL render it `note <at>`; `rk operator check` SHALL render the delta's detail as its `at`. `judgmentSet` SHALL NOT list the same item's pending-instruction reason twice.

- **GIVEN** a change record `{id: x, reasons: ["note 2026-11-20T10:00:00Z"]}`
- **WHEN** `judgmentSet` runs
- **THEN** item `x` is in the set

### Cron: Legacy-tick sweep

#### R11: Muted legacy operator-tick entries are removed once a loop entry exists
`cron.SweepLegacyOperatorTicks(dir, slug)` SHALL, in one atomic write via the existing mutate path, remove every entry with `isLegacyOperatorTick(e) && e.Muted` when the server's cron file holds a loop entry, and return the removed ids. It SHALL leave unmuted legacy entries, SHALL do nothing (and not write) when there is no loop entry or nothing to remove. The tick's seed step SHALL call it for each swept live server after `SeedOperatorLoop`, gated on the seed seam being configured, and the tick SHALL append one `LogLine{Entry: <id>, Outcome: "expired-legacy"}` per removed entry through its normal log-append path.

- **GIVEN** a cron file with a loop entry, a muted legacy entry A and an unmuted legacy entry B
- **WHEN** the tick runs
- **THEN** A is removed, B remains, and the log gains exactly one `expired-legacy` line for A
- **AND** a file with no loop entry is not rewritten

### Docs: CLI surface

#### R12: Skill topic and help-dump cover `rk operator wake`
`docs/site/skill/operator.md` SHALL document `rk operator wake` (the door; never a bare check to make the operator look), synced byte-identical to `cmd/rk/skill/operator.md`; `rk help-dump` fixtures/tests SHALL include the new verb.

- **GIVEN** the built CLI
- **WHEN** `go test ./cmd/rk/...` runs the help-dump and skill-sync tests
- **THEN** they pass with the new verb present

### Non-Goals

- No idle/stage (T1), engine/PR (T3), brief rules/diet (T4), PR hooks (T5), Activity/Check-now/activity endpoints (T6), Tasks band/composer wake (T7).
- No forced "run anyway"; no HTTP dependency for the door; no streak marker file.
- No binary install or daemon restart (plan Rule 1).
- Review bar (binding): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.

### Design Decisions

#### Trigger door is a marker file the tick consumes
**Decision**: `rk operator wake` / `POST /api/operator/wake` write `cron/<slug>.wake`; the tick reads it before `Evaluate`, fires the loop with `trigger:<reason>`, and deletes it once the fire is emitted.
**Why**: The check consumes the edges it reports, so only a loop fire is a safe way to "look"; a file needs no daemon, survives a restart (Constitution II), and keeps the tick the cron log's single writer.
**Rejected**: a bare `rk operator check` (swallows changes without a run); an HTTP call into the daemon (dependency, lost on restart); a forced run (the paid no-op the plan removes).
*Introduced by*: 261120-pgns-operator-trigger-door-failure-streaks

#### Push once per failure streak by reading the cron log
**Decision**: The wrapper skips the failed-run push when the loop entry's newest own log line is already a failure.
**Why**: The log already holds the streak; no new file to keep in sync.
**Rejected**: a streak marker beside the run records — a second source of truth.
*Introduced by*: 261120-pgns-operator-trigger-door-failure-streaks

## Tasks

### Phase 1: Setup

- [x] T001 [P] Add `IsLoopFailureOutcome` to `internal/cron/loop.go` and make `LoopLadder` climb on `no change` or failure lines; update its doc comment; add ladder cases (failure tails, mixed, reset by `ran`/`skipped-busy`) and a `DeriveEntry` next-fire-on-failure-streak case in `internal/cron/loop_test.go` / `derive_test.go` <!-- R1 -->
- [x] T002 [P] Add `WakePath` to `internal/cron/dir.go` and a new `internal/cron/wake_marker.go` with `WakeMarker`, `NormalizeWakeReason`, `WriteWakeMarker`, `ReadWakeMarker`, `RemoveWakeMarker` (named constants for the default reason and the 120-rune cap); tests in `internal/cron/wake_marker_test.go` (format, 0600, overwrite, unparseable → manual, control chars/over-cap rejected, remove-absent ok) <!-- R3 -->

### Phase 2: Core Implementation

- [x] T003 Wire the trigger into `internal/cron/evaluate.go` (`EvalInput` trigger reason; loop entry due after muted/in-flight checks; one fire, trigger reason wins, rung 0) and `internal/cron/tick.go` (read marker per live server before `Evaluate`; delete before calling the runner when a trigger fire was emitted, incl. rate-capped; `wake-marker-remove-failed` diagnostic); tests in `evaluate_test.go`/`tick_test.go`: consumed exactly once with `trigger:<reason>` in the log line, left in place on dead server / run in flight / muted / no loop entry, rate-capped trigger consumed with a `rate-capped` line carrying the reason <!-- R5 -->
- [x] T004 Add `SweepLegacyOperatorTicks` to `internal/cron/seed.go`, call it from the tick's seed step (gated on the seed seam), reorder `tickServer` so removed ids are logged via `appendLine` as `expired-legacy`; refresh `seed.go`'s header comment; tests in `seed_test.go`/`tick_test.go` (muted removed, unmuted kept, no loop entry ⇒ no write, one line per removed entry) <!-- R11 -->
- [x] T005 Add `Reason` to `operatorloop.Record` (`record.go`), set it in `persistRun` (`runner.go`), use it in `Transcribe` with the `schedule` fallback (`transcribe.go`); tests in `transcribe_test.go`/`runner_test.go` <!-- R6 -->
- [x] T006 Check records in `internal/operatorloop`: new `checkrecord.go` (struct with the R8 fields, writer, lister, `CheckRetention = 200`), generate the fire id in `Run` and reuse it for the run (`persistRun` takes the id), write on `no change` and changed fires, extend `Prune` in `record.go` to prune check records; tests (no change record, changed record with `run`, none for skipped-busy/check-failed, retention 200 leaves run records alone) <!-- R8 -->
- [x] T007 Push once per streak in `internal/operatorloop/exec.go` `reportFailure`: read the newest own loop line through a test seam (cron `DefaultDir`/`LogPath`/`ReadLog`/`OwnDeliveries`), skip the push when it is a failure; tests in `exec_test.go` (first failure pushes, streak suppresses, after `ran` pushes again, unreadable log pushes, note always written) <!-- R2 -->
- [x] T008 Notes as conditions in `internal/operator`: move the pending-instruction rule into an exported helper (e.g. `PendingInstruction(notes) (at string, ok bool)`), add `condNotePrefix`, `DeltaNote`, the `At` field + `MarshalJSON` case in `check.go`, derive the condition for every item in `check_conditions.go`; tests in `check_test.go` (fires once, open, cleared by run note, new chat note fires again, done/paused items report it, JSON shape) <!-- R9 -->
- [x] T009 Judgment + rendering: `operatorloop/judgment.go` uses the shared helper, `reasonNeedsJudgment` accepts `note`, no duplicate reason for the same item; `reasonFor` in `runner.go` renders `note <at>`; `cmd/rk/operator_check.go` `checkDetail` renders the `at`; tests in `judgment_test.go` <!-- R10 -->

### Phase 3: Integration & Edge Cases

- [x] T010 New `cmd/rk/operator_wake.go` (`rk operator wake [-L] [--reason] [--json]`, registered on `operatorCmd`, help text per R4) with `cmd/rk/operator_wake_test.go` (writes marker under a temp `XDG_STATE_HOME`, default `manual`, bad reason exit 2, JSON envelope) <!-- R4 -->
- [x] T011 `POST /api/operator/wake`: handler in `api/operator.go` (or a new `api/operator_wake.go`), route in `api/router.go` beside `/api/operator/start`, cron-dir seam on the server struct; tests in `api/operator_wake_test.go` (200 + marker, 400 bad server, 400 bad reason) <!-- R7 -->

### Phase 4: Polish

- [x] T012 Docs/fixtures: add the `rk operator wake` paragraph to `docs/site/skill/operator.md` and sync `cmd/rk/skill/operator.md` (byte-identical); update `rk help-dump` fixtures/tests in `cmd/rk`; run `cd app/backend && go test ./...` and `go vet ./...` green (known host-only failures `TestPortPinRowRealPolicyValues`, `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath` excepted) <!-- R12 -->

## Execution Order

- T002 blocks T003, T010, T011
- T001 blocks T007 (uses `IsLoopFailureOutcome`)
- T005 blocks T006 (both touch `persistRun`/`Record`)
- T008 blocks T009
- T003 and T004 both edit `tick.go`; run sequentially

## Acceptance

### Functional Completeness

- [x] A-001 R1: `LoopLadder` climbs on `no change` and all three failure classes, resets on any other own line; `IsLoopFailureOutcome` is the single classifier
- [x] A-002 R2: `reportFailure` writes the note every time and pushes only when the previous own loop line is not a failure
- [x] A-003 R3: Marker helpers exist with the exact `<unix-ts> <reason>\n` format, 0600, atomic write, shared normalizer
- [x] A-004 R4: `rk operator wake` writes the marker with no daemon, default reason `manual`, exit codes 0/1/2 as specified
- [x] A-005 R5: The tick fires the loop once per marker with `trigger:<reason>` in the fire and log line and deletes the marker before the runner call
- [x] A-006 R6: Run records carry `reason`; transcribed lines use it with a `schedule` fallback
- [x] A-007 R7: `POST /api/operator/wake` writes the marker before a 200 `{server, reason}` and is POST-only
- [x] A-008 R8: Check records are written for every fire whose check ran, with the specified fields, shared fire/run id, retention 200
- [x] A-009 R9: `note@<at>` condition / `note` delta derived for every item, edge-triggered, one shared helper owns the rule
- [x] A-010 R10: `note` is a judgment reason, rendered `note <at>` in run reasons and the check CLI, no duplicate reason per item
- [x] A-011 R11: Sweep removes only muted legacy operator-tick entries when a loop entry exists, logs one `expired-legacy` line each
- [x] A-012 R12: Skill topic (both copies, in sync) and help-dump include `rk operator wake`

### Behavioral Correctness

- [x] A-013 R1: A failure streak no longer resets the loop to the 3-minute rung (watchdog/DeriveEntry next-fire follow the climbed rung)
- [x] A-014 R6: Wake/trigger-launched runs no longer transcribe as `schedule`

### Scenario Coverage

- [x] A-015 R5: Tests prove the marker is consumed exactly once and left in place on a dead server, run in flight, and muted entry
- [x] A-016 R8: Tests prove a check record exists for a `no change` fire
- [x] A-017 R9: Tests prove the note condition fires once and re-fires on a newer instruction note
- [x] A-018 R11: Tests prove the sweep removes muted entries only
- [x] A-019 R2: Tests prove one push per streak

### Edge Cases & Error Handling

- [x] A-020 R3: Reasons with control characters or > 120 runes are rejected by CLI (exit 2) and API (400) without writing
- [x] A-021 R5: A rate-capped trigger fire consumes the marker and its `rate-capped` line carries the trigger reason; a delete failure is a diagnostic, not a tick error
- [x] A-022 R8: A check-record write failure does not change the fire's outcome
- [x] A-023 R6: Reason-less records (written by the installed binary) transcribe correctly; new records stay readable by old code (additive JSON field)

### Code Quality

- [x] A-024 Pattern consistency: New code follows the naming, seam, and comment conventions of `internal/cron`, `internal/operatorloop`, `internal/operator`, `cmd/rk`, and `api`
- [x] A-025 No unnecessary duplication: The pending-instruction rule, the failure classifier, and the reason normalizer each have exactly one owner
- [x] A-026: No magic strings/numbers — default reason, reason cap, `CheckRetention`, condition prefix, `expired-legacy`, and the `trigger:` prefix are named constants
- [x] A-027: No god functions — `tickServer` and `Run` additions are factored into helpers rather than growing inline past readability
- [x] A-028: Comments state constraints only (no narration, no change IDs)
- [x] A-029: New behavior is covered by Go tests; `go test ./...` passes apart from the two known host-only failures

### Security

- [x] A-030 R4: Server names are validated before building any path; the marker path is built only from a `ValidSlug` slug; no subprocess is spawned by the door

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `app/backend/internal/operatorloop/record.go:224 listRunIDs` — near-verbatim twin of the new `ListCheckIDs` (`checkrecord.go:85`); differs only in the suffix, so one suffix-parameterized lister could serve both
- `app/backend/internal/operatorloop/judgment.go:47-51` (`pendingNoteReason` scan in `judgmentSet`) — partly redundant now that the `note@` condition feeds change records; kept as a backstop for an instruction an earlier fire reported (plan Assumption 4), so it's a candidate to revisit in T4, not to delete now

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Marker deleted before the runner call once a trigger fire is emitted (incl. rate-capped), not after the run | Prevents a crash mid-run from double-firing; a lost trigger after deletion is still covered by edge-triggered conditions | S:60 R:85 A:75 D:65 |
| 2 | Confident | Reason cap 120 runes; control characters rejected rather than collapsed | One-line marker; T5's `pr:<nwo>#<n>:<event>` fits; rejection is clearer than silent rewriting | S:55 R:90 A:75 D:65 |
| 3 | Confident | `rk operator wake` supports `--json` like `operator check` | Sibling verb convention; cheap | S:55 R:90 A:80 D:70 |
| 4 | Confident | `judgmentSet` keeps its pending-instruction scan but dedupes against the `note` reason | Covers an item whose condition was reported by an earlier fire; avoids double listing | S:55 R:90 A:75 D:65 |
| 5 | Confident | Check-record pruning lives in `Prune` (called by `Transcribe`), counting only `.check.json` files | Brief: "transcription prunes it with the run records" | S:70 R:85 A:80 D:75 |
| 6 | Confident | Sweep gated on the seed seam, independent of the state-file switch | The Brief conditions only on a loop entry existing | S:60 R:75 A:75 D:65 |

6 assumptions (0 certain, 6 confident, 0 tentative).
