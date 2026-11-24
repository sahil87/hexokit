# Plan: Retry after a failed run

**Change**: 261124-5j8o-retry-after-failed-run
**Intake**: `intake.md`

## Requirements

### Operator check: the failed-run condition

#### R1: PendingFailure owns the unanswered-failure rule
`operator.PendingFailure(notes []Note) (at string, ok bool)` SHALL return the `at` of the item's newest `by: run` note
and `ok == true` exactly when that note's text starts with `FailureNotePrefix`. Notes whose `at` does not parse as
RFC3339 SHALL be ignored. `by: user` and `by: chat` notes SHALL NOT affect the result. Among `by: run` notes with
equal timestamps the later one in slice (append) order SHALL count as newest.

- **GIVEN** an item whose notes are `[user 10:00, run "run failed: exit 1 — x" 10:05]`
- **WHEN** `PendingFailure` is called
- **THEN** it returns `("…10:05…", true)`
- **AND** with a later `run "retried after failure: ok" 10:10` appended it returns `("", false)`
- **AND** a failure note and a success note at the same second, success appended last, returns `("", false)`

#### R2: The check derives `failed@<at>` for every item
`operator.Check` SHALL derive a standing condition keyed `failed@<at>` (where `<at>` is `PendingFailure`'s `at`) on
every tracked item — done, paused and active alike — reported through the existing edge mechanism as a delta of
kind `failed` (`{"kind":"failed","id":"<id>","at":"<at>"}`). The condition is a change the first time its key
appears and an open condition while it stays.

- **GIVEN** a done item and a paused item, each with a failure note as its newest run note
- **WHEN** the check runs
- **THEN** `changes` carries a `failed` delta for each, with `at` equal to the failure note's `at`
- **AND** the next check lists them under `open`, not `changes`, and does not set `changed`

#### R3: Each failure is one edge, a later run note clears it
A second failure note (newer `at`) SHALL produce a new `failed@` key and therefore a new change; a later non-failure
`by: run` note SHALL remove the condition (and its key from `reported`).

- **GIVEN** an item whose `failed@T1` was already reported
- **WHEN** a second failure note at T2 is appended and the check runs
- **THEN** `changes` carries `failed` with `at == T2`
- **WHEN** a `by: run` note (non-failure) is appended later and the check runs
- **THEN** neither `changes` nor `open` carries a `failed` delta and `reported` no longer holds a `failed@` key

### Operator loop: judgment

#### R4: `failed` is a judgment reason rendered `failed <at>`
The loop SHALL render a `failed` delta's reason as `failed <at>` and SHALL treat it as needing judgment for every
item, engine-owned or not. The wrapper's failure notes, the failure ladder and the once-per-streak push are
unchanged; no fallback scan re-adds an already-reported `failed` condition.

- **GIVEN** a change record with reason `failed 2026-11-23T19:19:00Z` on an engine-owned queue item
- **WHEN** the judgment set is computed
- **THEN** the item is in the set with that reason

#### R5: A failed run is retried on the next fire
- **GIVEN** an isolated tmux server, an item with an unanswered user note, and a launcher that fails
- **WHEN** the loop fires, the run fails (failure note written), the launcher is fixed and the loop fires again
- **THEN** the second fire launches a run whose change record carries the item with a reason of kind `failed`
- **AND** after that run notes the item, the next fire is `no change`

### Run brief and CLI

#### R6: The exit contract asks for a note on a retried item
The brief's exit contract SHALL tell the run that an item listed with a `failed <at>` reason gets a note
`retried after failure: <what it found>` even when the run did nothing on it, because until a run note follows the
failure note the item stays flagged. The general "a run that did nothing writes no note" rule stays.

- **GIVEN** the rendered brief
- **WHEN** the `## Exit contract` section is read
- **THEN** it contains `retried after failure:` and still contains `A run that did nothing writes no note`

#### R7: `rk operator check` renders the `failed` delta
The human renderer of `rk operator check` SHALL render a `failed` delta's detail as its `at`, like `note`.

- **GIVEN** a `failed` delta with `at` T
- **WHEN** rendered
- **THEN** the detail is T

### Non-Goals

- No change to the wrapper (`exec.go`, `notes.go`), `cron.LoopLadder`, or the push-once-per-streak rule.
- No retry counter, timer, forced run, or new state file.
- No change to `PendingInstruction`.
- No frontend change; no CLI flag/verb/help change.
- Review bar (plan § Decisions): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts
  state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.

### Design Decisions

#### A failed run is retried, not forgotten
**Decision**: The wrapper's `run failed:` note is itself the condition: `failed@<at>` holds while the newest run note
is a failure note, keyed by that note's `at`, on every item.
**Why**: The check consumes the edges it reports, so a run that failed after the check left the item's condition
open forever — on a done item, permanently. The failure note is already durable state (Constitution II); the T2
failure ladder already spaces consecutive failing fires.
**Rejected**: Un-consuming the edge on failure (the wrapper would have to rewrite `reported` and the check would need
to know run outcomes); a forced re-run (the plan's "No forced run" decision); a fallback scan in the judgment set
(an un-noted failure would ride every later run).
*Introduced by*: 261124-5j8o-retry-after-failed-run

## Tasks

### Phase 1: Core Implementation

- [x] T001 Add `PendingFailure` to `app/backend/internal/operator/schema.go` beside `PendingInstruction`, and its table test in `app/backend/internal/operator/check_test.go` <!-- R1 -->
- [x] T002 Add `DeltaFailed = "failed"` + `MarshalJSON` case + widen the `At` comment in `app/backend/internal/operator/check.go`; add `condFailedPrefix` and the derivation in `itemConditions` in `app/backend/internal/operator/check_conditions.go`; check tests (done/paused, open on second check, second failure new key, later run note clears, JSON form) in `check_test.go` <!-- R2 -->
- [x] T003 Add the `failed` case to `reasonFor` (`app/backend/internal/operatorloop/runner.go`) and to `reasonNeedsJudgment` (`app/backend/internal/operatorloop/judgment.go`), with cases in `judgment_test.go` / `runner_test.go` <!-- R4 -->
- [x] T004 Add the `retried after failure:` line to `briefExitContract` in `app/backend/internal/operator/brief.go`; update `brief_test.go` and `testdata/brief_golden.md` <!-- R6 -->
- [x] T005 Add the `failed` render case in `app/backend/cmd/rk/operator_check.go` and its table case in `operator_check_test.go` <!-- R7 -->

### Phase 2: Integration

- [x] T006 Isolated-tmux integration test in `app/backend/internal/operatorloop/` (failing launcher → failure note → fixed launcher → next fire launches with a `failed` reason → then `no change`); run `just test-backend` <!-- R5 -->

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `PendingFailure` exists in `schema.go` and its table test covers newest-failure, cleared-by-later-run-note, refailure, user/chat-ignored, unparseable-ignored, same-second tie
- [ ] A-002 R2: `Check` reports a `failed` delta for done, paused and active items whose newest run note is a failure note; JSON form is `{"kind":"failed","id":…,"at":…}`
- [ ] A-003 R4: `reasonFor` renders `failed <at>` and `reasonNeedsJudgment` returns true for it regardless of ownership
- [ ] A-004 R6: the exit contract carries the `retried after failure:` line; golden updated
- [ ] A-005 R7: `rk operator check` renders a `failed` delta's `at`

### Behavioral Correctness

- [ ] A-006 R3: a second failure yields a new key in `changes`; a later non-failure run note clears the condition from `changes`, `open` and `reported`

### Scenario Coverage

- [ ] A-007 R5: the integration test proves failing launcher → retry with reason `failed` → `no change` after the retry's note

### Edge Cases & Error Handling

- [ ] A-008 R1: a failure note and a success note in the same second resolve by append order
- [ ] A-009 R4: the wrapper, ladder and push rule are untouched (no diff in `exec.go`, `notes.go`, `internal/cron`)

### Code Quality

- [ ] A-010 Pattern consistency: new code mirrors the `note@` / `PendingInstruction` / `DeltaNote` shapes
- [ ] A-011 No unnecessary duplication: `PendingFailure` is the single owner of the rule; check and nothing else derives it
- [ ] A-012: Tests cover the added behavior (code-quality: new features and bug fixes MUST include tests)
- [ ] A-013: Comments state constraints only — no narration, no change IDs or PR numbers
- [ ] A-014: No magic strings — the `failed@` prefix and delta kind are named constants

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The integration test calls `Run` and `Transcribe` directly on an isolated tmux server rather than through `cron.Tick` | `cron.Tick` dueness after a failure depends on the ladder rung; calling `Run` directly exercises the same check → launch path without wall-clock waits | S:60 R:90 A:75 D:70 |
| 2 | Confident | `PendingFailure` tests live in `check_test.go` next to `TestPendingInstruction` | That is where the sibling rule's test lives | S:70 R:95 A:85 D:80 |

2 assumptions (0 certain, 2 confident, 0 tentative).
