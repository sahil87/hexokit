# Plan: Operator check — idle defined (same-window worker + 3-min floor), stage baseline seeded

**Change**: 261120-9ypa-operator-check-idle-floor-stage-seed
**Intake**: `intake.md`

## Requirements

### Operator check: pane snapshot

#### R1: Snapshot rows carry the tmux window id
The pane snapshot taken by `operator.Check` SHALL record, for every pane, the id of the tmux window that contains it (`tmux.WindowInfo.WindowID`, e.g. `@3`), taken from the existing `ListWindowsStrict` listing. No additional tmux call SHALL be made.

- **GIVEN** a server with window `@3` holding panes `%1` and `%2`
- **WHEN** `defaultPaneSnapshot` runs
- **THEN** both rows carry `WindowID == "@3"`

### Operator check: idle condition

#### R2: `agent:idle` requires the work to have stopped
For a clean-joined pane item whose observed agent state is `idle`, the `agent:idle` condition (and its `agent_state` delta) SHALL be derived only when both hold: (a) no other pane in the snapshot with the same non-empty window id has reconciled agent state `active`; (b) the idle state has held at least `idleFloor` (a named constant, 3 minutes) by the pane's agent-state epoch. A pane with no epoch (`AgentEpoch == 0`) SHALL be treated as having reached the floor. Sibling panes need not be tracked items.

- **GIVEN** a tracked pane idle for 5 minutes and a sibling pane in the same window that is `active`
- **WHEN** the check runs
- **THEN** no `agent_state` change and no `agent:idle` open condition is reported, and `scope.agent` is `idle`
- **GIVEN** a tracked pane idle for 30 seconds and no active sibling
- **WHEN** the check runs
- **THEN** nothing is reported
- **GIVEN** a tracked pane idle for 3 minutes, no active sibling in its window (an `active` pane in another window)
- **WHEN** the check runs
- **THEN** an `agent_state` change with `to: idle` and `duration: "3m"` is reported

#### R3: Suppressed idle advances the baseline silently and resumes without a burst
While R2's gate is not met, `scope.agent` SHALL still advance to the observed state and nothing SHALL be reported. The first check at which the gate is met SHALL report exactly one `agent_state` delta carrying the real held `duration`; its `from` SHALL be the stored baseline, or null when that baseline already equals the observed state.

- **GIVEN** a pane whose idle was suppressed at the previous check (baseline now `idle`)
- **WHEN** the idle passes the floor with no active sibling
- **THEN** one `agent_state` change is reported with `from: null`, `to: idle` and the held duration
- **AND** the next check lists it under `open` with no new change

#### R4: Waiting and aged conditions are unchanged
`agent:waiting` SHALL remain immediate (no floor, no sibling rule). `agent:idle:aged` and `agent:waiting:aged:<n>` SHALL be derived as before, independent of R2's gate.

- **GIVEN** a tracked pane waiting for 30 seconds with an active sibling in its window
- **WHEN** the check runs
- **THEN** an `agent_state` change `to: waiting` is reported
- **GIVEN** a tracked pane idle for 31 minutes with an active sibling
- **WHEN** the check runs
- **THEN** `agent_aged` is reported and `agent_state` is not

### Operator check: stage baseline

#### R5: A missing stage baseline is seeded without an event
When a clean-joined pane item has an empty `scope.stage` and the snapshot resolved a stage, the check SHALL write that stage as `scope.stage` and report no event. From the next check on, a differing stage SHALL report `stage_advance`, or `review_fail` for `review → apply`, as before.

- **GIVEN** a pane item with `stage: null` observed at `apply`
- **WHEN** the check runs
- **THEN** no change is reported and `scope.stage == "apply"`
- **AND WHEN** the next check observes `review` **THEN** `stage_advance` `apply → review` is reported
- **AND WHEN** a later check observes `apply` **THEN** `review_fail` `review → apply` is reported

### Non-Goals

- Widening "same window" to "same worktree in another window" — the plan starts narrow until data shows the gap.
- Any change to the cron wake fingerprint, `LoopLadder`, the autopilot engine, `CheckResult` shape, CLI, API, or UI.
- Review bar (plan, binding): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.

### Design Decisions

#### Idle means the work stopped
**Decision**: `agent:idle` is a condition only when no other pane in the same tmux window is `active` and the idle state has held at least `idleFloor` (3 min); until then `scope.agent` advances silently. `waiting` stays immediate; the 30-minute aged conditions are unchanged.
**Why**: 48 of 56 no-op operator runs fired on an idle under 60 s with a worker pane active in the same window — a `/fab-fff` parent idling between stages. Both facts are in the one pane snapshot the check already takes (Constitution X: derive, don't push).
**Rejected**: same worktree in another window (start narrow; widen only if data shows the gap); a model-side rule to ignore short idles (still pays for the run); a debounce in the cron wake path (the check is the gate that decides whether a run launches).
*Introduced by*: 261120-9ypa-operator-check-idle-floor-stage-seed

## Tasks

### Phase 1: Core Implementation

- [x] T001 Add `WindowID` to `paneRow` and fill it from `w.WindowID` in `defaultPaneSnapshot` (`app/backend/internal/operator/check_pane.go`) <!-- R1 -->
- [x] T002 Add `idleFloor = 3 * time.Minute` to `app/backend/internal/operator/check_conditions.go`; in `check_pane.go` pass the snapshot into `trackAgent` (via `joinPane`), gate the `agent:idle` condition on a new `idleStopped` helper (floor + no active same-window sibling), set `from` null when the baseline already equals the observed state, and leave waiting/aged derivation unchanged <!-- R2 -->
- [x] T003 Seed an empty `scope.stage` from the observed stage without an event in `trackStage` (`check_pane.go`), updating its doc comment <!-- R5 -->

### Phase 2: Tests

- [x] T004 In `app/backend/internal/operator/check_pane_test.go`: add a table-driven idle test (worker-active, floor-not-reached, both-pass incl. active pane in another window, waiting-unaffected, no-epoch, resume-without-burst with `from: null`, aged-with-active-sibling); flip `TestCheck_StageAdvanceReviewFailAndNoBaseline`'s no-baseline case to seed-then-`stage_advance`-then-`review_fail`; adjust `TestCheck_AgentAged` idle epochs to clear the floor while keeping its intent; run `go test ./internal/operator/ ./...` <!-- R3 -->

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `paneRow.WindowID` is populated from `WindowInfo.WindowID` in `defaultPaneSnapshot` with no new tmux call
- [ ] A-002 R2: `agent:idle` is derived only when no other same-window pane is `active` and the idle epoch is ≥ `idleFloor` (named constant, 3m); epoch 0 counts as reached
- [ ] A-003 R3: under the gate `scope.agent` still advances and nothing is reported; the first gated-through check reports one `agent_state` with the real duration and `from: null` if the baseline was already `idle`
- [ ] A-004 R5: an empty `scope.stage` is seeded from the observed stage with no event

### Behavioral Correctness

- [ ] A-005 R4: `agent:waiting` fires immediately regardless of siblings; aged conditions are unchanged and fire even with an active sibling
- [ ] A-006 R5: after seeding, `stage_advance` and `review_fail` report as before

### Scenario Coverage

- [ ] A-007 R2: tests cover worker-active, floor-not-reached, both-pass (with an active pane in a different window), and no-epoch
- [ ] A-008 R3: a test covers suppressed-then-passing idle producing exactly one change then `open`
- [ ] A-009 R4: tests cover waiting-unaffected and aged-with-active-sibling
- [ ] A-010 R5: the stage test covers seed → `stage_advance` → `review_fail`

### Edge Cases & Error Handling

- [ ] A-011 R2: a pane with an empty `WindowID` is never blocked by other empty-window panes

### Code Quality

- [ ] A-012 Pattern consistency: new code follows the naming and structure of `check_pane.go` / `check_conditions.go`
- [ ] A-013 No unnecessary duplication: uses `tmux.AgentStateActive`/`AgentStateIdle` and existing helpers (`nullable`, `FormatAgentDuration`)
- [ ] A-014 No magic numbers: the floor is the named constant `idleFloor`
- [ ] A-015 Comments state constraints only — no narration, no change ids
- [ ] A-016 Tests: `go test ./...` in `app/backend` is green apart from the known host-only failures

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Gate lives in `trackAgent`, which receives the snapshot map | Brief names `trackAgent`; the snapshot is already in `obs.panes` | S:85 R:90 A:90 D:85 |
| 2 | Confident | An empty `WindowID` never matches siblings | Defensive: test fixtures and any row without a window must not group together | S:60 R:90 A:80 D:75 |
| 3 | Confident | `from` is null when the baseline already equals the observed state (any condition state, not only idle) | Same rule generalizes harmlessly; for waiting the baseline equals only on a re-edge after the key dropped | S:55 R:90 A:70 D:65 |
| 4 | Certain | Existing `TestCheck_AgentAged` idle epochs move past the floor, intent kept | Test Integrity: tests follow the spec | S:85 R:95 A:90 D:85 |

4 assumptions (2 certain, 2 confident, 0 tentative).
