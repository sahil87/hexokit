# Plan: Engine re-scope — PR work returns to the operator

**Change**: 261120-7uqm-engine-rescope-pr-work-to-operator
**Intake**: `intake.md`

All code paths are relative to `app/backend/` unless they begin with `docs/`.

## Requirements

### Autopilot: Rule table

#### R1: Rule table holds queue rows only
The rule table SHALL contain exactly the rows X0, X1, Q1, Q2, Q3, Q4, Q5, all of kind queue, in that order. Rows P1–P7, B1–B2, C1–C6, F1, F2, Q6a, Q6b, Q7 and the PR-kind X0/X1 SHALL NOT exist, nor their action kinds (`track-pr`, `record-merged`, `halt`, `disarm`, `ready`, `arm`, `merge`, `restack`, `fix-request`, `recovery-spawn`, `rebase`, `untrack`), item kinds (`kindPR`, `kindFix`), PR/fix statuses or wait entries. Every reachable (queue status × merge mode) combination SHALL have a row or a declared wait.

- **GIVEN** a spawned queue item whose stage has not moved for 40 minutes and a queue open for 3 hours
- **WHEN** a pass runs
- **THEN** no escalation is decided for it (the item waits as `spawned`)
- **AND** the `decide` enumeration over every `QueueStatus` × mode reports no `unmatched`

#### R2: PR executors, PR observation and PR helpers are deleted
`merge.go`, `restack.go`, `recovery.go` and their tests SHALL be deleted; `execute.go` SHALL keep only `record-done`, `spawn`, `respawn`, `skip`, `escalate` and `re-project` dispatch; `observe.go` SHALL NOT read `gh pr view` for PR items, `gh pr checks` outside completion, `gh repo view --json autoMergeAllowed`, or the compare API, and SHALL NOT write PR poll bookkeeping to the ledger. No flag, build tag or dormant path SHALL keep any of them reachable. Symbols left without callers SHALL be deleted.

- **GIVEN** the package after the change
- **WHEN** `go vet ./...` and `go build ./...` run
- **THEN** they pass and `grep -n 'autoMergeAllowed\|--disable-auto\|compare/' internal/autopilot` returns nothing

### Autopilot: Engine file

#### R3: Engine file is queue-only and reads legacy files tolerantly
`engineState` SHALL hold `version`, `migrated` and `queue` only; `engineItem` SHALL hold only queue keys (`id`, `queue`, `repo`, `change`, `task`, `bare`, `branch`, `worktree`, `merge_mode`, `stop_stage`, `depends_on`, `paused`, `spawning`, `respawned`, `skipped`, `pane`, `session`, `projected`, `done_at`, `escalated`, `added_at`, `updated_at`, `spawned_by`). A file that still carries `prs:`/`fixes:` lists or the removed item keys SHALL load without error, ignore them, and lose them on the next locked write. `OwnedIDs` SHALL return queue item ids only.

- **GIVEN** an engine file with one queue item carrying `halted: true`, `pr_dropped: true`, `recovery: [ci-fix]`, plus a `prs:` list with `pr-41` and a `fixes:` list with `fix-1`
- **WHEN** `step` runs
- **THEN** it succeeds, the queue item is managed normally, the rewritten file holds no `prs`, `fixes` or removed keys
- **AND** `OwnedIDs` does not contain `pr-41` or `fix-1`

#### R4: Migration no longer absorbs PR items
The one-time migration SHALL absorb only ledger `pane` items carrying `scope.queue` or a non-null `scope.merge_mode`; a `github-pr` ledger item carrying `scope.merge_seq` SHALL stay an ordinary ledger item untouched by the migration.

- **GIVEN** an unmigrated ledger with a queue pane item and a `github-pr` item with `scope.merge_seq`
- **WHEN** a lock-holding verb runs
- **THEN** the pane item moves to the engine file and the `github-pr` item stays in the ledger as it was

### Autopilot: Readiness

#### R5: merge-auto barrier reads the dependency PR's merged state
In `merge-auto`, a queue item whose dependency is a `merge-auto` queue item SHALL stay `held` until that dependency is done AND its branch's PR is observed `MERGED` this pass, read with `gh pr view <dep-branch> --json url,state` in the dependency's repo. A "no pull requests found" answer SHALL be a plain held state; any other read failure SHALL escalate `dependency <id> PR lookup failed: …` in `step` (silent in read-only `status`); a dependency with no branch SHALL escalate `dependency <id> has no branch recorded`. Same-repo null-`stop_stage` PR-existence and plain-agent completion reads SHALL be unchanged.

- **GIVEN** two merge-auto queue items `a`→`b`, `a` done and its PR `OPEN`
- **WHEN** a pass runs
- **THEN** `b` is `held` and not spawned
- **AND** once `a`'s PR reads `MERGED`, the next pass spawns `b`

### Autopilot: CLI verbs

#### R6: `merge` verb is deleted
`rk operator autopilot` SHALL have seven children: `queue`, `step`, `stop`, `status`, `rm`, `resume`, `pause`. `merge` SHALL NOT exist, and help text SHALL NOT mention it or merge sequences.

- **GIVEN** the built CLI
- **WHEN** `rk operator autopilot merge` runs
- **THEN** cobra reports an unknown command (non-zero) and `rk operator autopilot --help` lists seven verbs

#### R7: `stop`, `rm`, `resume` lose their PR halves
`stop` SHALL write `paused` on every unspawned, unfinished queue item and run one pass, writing no `halted` and reading no PR. `rm <id>` SHALL drop only an unspawned queue item (refusing one a not-done item depends on, exit 2); any other id, including a former PR item id or a `merge_seq`, SHALL be a usage error (exit 2). `resume <id>` SHALL clear `paused` or `skipped` on one queue item and run a pass; an item with neither, or an unknown id, SHALL be a usage error (exit 2). Help text SHALL state exactly this.

- **GIVEN** a halted-only item id or `pr-41` from a legacy file
- **WHEN** `rm pr-41` or `resume pr-41` runs
- **THEN** the command exits 2 naming an unknown id and writes nothing

#### R8: `status` and `step` report queue facts only
`status --json` SHALL keep `state`, `merge_mode`, `task`, `change`, `stop_stage`, repo and branch, and SHALL NOT carry `pr_status` or a `fixes` list; the human table SHALL have no PR column; the Queue Completion Summary SHALL stay. `step` SHALL report only `spawned`, `respawned`, `cherry-picked`, `paused`, `done`, `removed`, `resumed` action lines and escalations.

- **GIVEN** a completed merge-auto queue
- **WHEN** `status --json` runs
- **THEN** no entry has `pr_status`, the result has no `fixes`, and `summary` is present

### Operator loop: Judgment set

#### R9: PR deltas are judgment
`reasonNeedsJudgment` SHALL treat a `changed` delta on a `github-pr` item and a `done` delta on a `github-pr` item (regardless of `then`) as judgment. A `changed` on any other kind, and a `done` on a non-PR item without `then`, SHALL NOT be. `pane_death`/`pane_mismatch`/`agent_exited` on an engine-owned id SHALL stay non-judgment.

- **GIVEN** a `github-pr` ledger item `pr-41` with a `changed state:OPEN→MERGED`-style delta, and a pane item with a `done` delta and no `then`
- **WHEN** `judgmentSet` runs
- **THEN** `pr-41` is in the set and the pane item is not

### Surface text

#### R10: Settings description, chat skill and track help match the smaller engine
The `operator.merge_mode` setting description SHALL state that the mode shapes spawn (ladder cherry-pick, stacked base, merge-auto unchained) and gives the operator its merge authority (`merge-auto`: merge green PRs without asking; the other two: only on the user's word). `docs/site/skill/operator.md` and its synced copy `cmd/rk/skill/operator.md` SHALL NOT name `rk operator autopilot merge`, removal of a halted sequence, resuming a halted item, or the engine arming PRs; "merge all" SHALL be the chat's own job under the mode's authority. `rk operator track rm` help SHALL NOT mention a halted merge sequence. `brief_rules.md` SHALL stay untouched (T4).

- **GIVEN** the repo after the change
- **WHEN** `grep -rn 'autopilot merge\|halted sequence\|halted merge' docs/site app/backend --include='*.go' --include='*.md'` runs (excluding `docs/memory`, `fab/`)
- **THEN** it finds nothing

### Non-Goals

- New rows, or any flag keeping PR executors reachable — plan Rule 7.
- Brief rules, the per-mode Merging section, restored git/gh/wt tools, `track show` — T4.
- `operator.Check`, the loop ladder, the trigger door — T1/T2.
- Spawn path, pass lock, engine-file changes beyond removing keys (the R5 barrier read is the one readiness change needed once PR items vanish).
- **Review bar** (plan Rule 4): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.

### Design Decisions

#### PR work returned to the operator
**Decision**: The autopilot engine keeps only queue work (X0, X1, Q1–Q5: readiness, SHA-pinned spawn with the three modes' chaining, one respawn, completion). Readying, arming, merging, restacking, CI-fix and conflict recovery move to the operator run; a merge mode keeps shaping spawn and becomes the run's merge authority.
**Why**: The PR rows never armed a PR on gh 2.103 (`autoMergeAllowed` is not a field), and their escalations became model runs that could only re-explain them; the PR half has the widest outcome space (conflicts, red CI, retargets), which is where judgment pays (`fab/plans/sahil/26-11-20-operator-triggers.md`).
**Rejected**: Fixing `autoMergeAllowed` in place and keeping the table — keeps the widest outcome space in fixed rows; keeping executors behind a flag — plan Rule 7.
*Introduced by*: 261120-7uqm-engine-rescope-pr-work-to-operator

#### merge-auto barrier reads the dependency's PR directly
**Decision**: A merge-auto successor waits until the dependency's branch PR reads `MERGED` via `gh pr view <branch> --json url,state`, a per-pass fact.
**Why**: The barrier used to read the Q7 PR item, which no longer exists; without a replacement a successor would spawn off an unmerged base.
**Rejected**: Storing a merged marker in the engine file — non-monotone facts are read fresh, never stored.
*Introduced by*: 261120-7uqm-engine-rescope-pr-work-to-operator

### Deprecated Requirements

#### Merge — cherry-pick-ladder, merge-auto and stacked-prs chains
**Reason**: PR merging is the operator run's job.
**Migration**: The run merges under the mode's authority (T4 brief rules); `merge` verb removed.

#### Restack and direct merge of stacked chains
**Reason**: Same.
**Migration**: The run restacks (T4 Merging section).

#### Bounded PR recovery (C1–C6, fix items) and slow-stage/slow-queue escalations (Q6a/Q6b)
**Reason**: Judgment work / noise; the check's aged conditions cover "stuck".
**Migration**: Red CI and conflicts go to the run; stuck agents surface via `agent_aged`.

## Tasks

### Phase 1: Core deletion

- [x] T001 Delete `internal/autopilot/merge.go`, `restack.go`, `recovery.go` and `merge_test.go`, `restack_test.go`, `recovery_test.go` <!-- R2 -->
- [x] T002 `internal/autopilot/rules.go`: reduce the table to X0, X1, Q1–Q5 (queue only); drop PR/fix action kinds, item kinds, rule/wait/Decision PR/fix fields, PR-only guards and texts, `oldestUnfinished`, Q6 constants; queue-only wait table <!-- R1 -->
- [x] T003 `internal/autopilot/status.go`: delete `PRStatus`, `FixStatus`, `prFacts`, `facts.pr`/`autoMerge`, halted-cone/observed-merged/blocked/predecessor/derivePR/deriveFix/authoringPane helpers and anything left unused <!-- R1 -->
- [x] T004 `internal/autopilot/observe.go` + `execute.go`: delete PR observation (`observePRs`, `observePR`, `observeStaleBase`, `observePRWrite`, `observeAutoMerge`, `isSeqPR`, `firstFailed`) and PR executors (`trackPR`, `recordMerged`, `halt`, `disarm*`, `target`, `prFinished`, `ready`, `arm`, `merge`, helpers); keep `requiredChecks`/`checksPending` for `plainAgentDone` <!-- R2 -->
- [x] T005 `internal/autopilot/enginefile.go`: queue-only `engineState`/`engineItem`; delete `upsertFix`, `fixParent`, `recoveryValues`, `roundSpent`, `pr` param of `upsert`; `OwnedIDs` queue ids only; `internal/autopilot/migrate.go`: stop absorbing `github-pr` `merge_seq` items <!-- R3, R4 -->
- [x] T006 `internal/autopilot/autopilot.go`, `repo.go`, `step.go`, `rm.go`, `queue.go`, `spawn.go`, `riffspawn.go`: remove PR-only fields/helpers (`coneErr`, report fields, `prNum`, `nameWithOwner`/`withRepo`/`Panes.Send` if unused); `Stop` pauses unspawned items only; `Remove` drops only unspawned queue items; `Resume` clears paused/skipped only; `Status` drops `PRStatus`/fixes; delete `StartMerge`/merge entry points <!-- R2, R7, R8 -->

### Phase 2: Readiness and judgment

- [x] T007 `internal/autopilot/gate.go` + `status.go` + `observe.go`: replace `mergeAutoBarrier`'s `prMerged` with a per-pass `depMerged` fact read in `observeReadiness` via `viewPR(<dep repo>, "", <dep branch>, "url,state")`; no-PR = held, other failure escalates (silent read-only), no branch escalates <!-- R5 -->
- [x] T008 `internal/operatorloop/judgment.go`: `changed` and `done` on a `github-pr` item are judgment; update `judgment_test.go` with the four rows from the intake <!-- R9 -->

### Phase 3: CLI and surface text

- [x] T009 `cmd/rk/operator_autopilot.go`, `operator_autopilot_admin.go`: delete the `merge` command and registration; rewrite parent, `stop`, `rm`, `resume`, `status`, `step` help and exit-code text to the queue-only engine; drop `pr_status`/fixes/PR column rendering <!-- R6, R7, R8 -->
- [x] T010 `cmd/rk/operator_track.go`: drop "or a halted merge sequence" from `track rm` help <!-- R10 -->
- [x] T011 `internal/settings/settings.go`: rewrite the `operator.merge_mode` description and its struct comment (spawn shape + merge authority) <!-- R10 -->
- [x] T012 `docs/site/skill/operator.md` → sync `cmd/rk/skill/operator.md` (via the repo's existing sync mechanism or identical copy): remove `autopilot merge`, halted-sequence `rm`, halted `resume`, engine-arms-PRs wording; "merge all" = the chat's own job under the mode's authority (one line) <!-- R10 -->

### Phase 4: Tests

- [x] T013 Prune tests in `internal/autopilot/*_test.go` (rules, revised_rules, escalation, status, ownstate, lifecycle, passes, deltas, durability, enginefile, migrate, harness, spawn, spawning, queue, gate) and `cmd/rk/operator_autopilot*_test.go`, `operator_track_test.go`, help-dump/toolkit tests of PR/fix/merge/Q6/Q7 cases; shrink the `decide` enumeration to queue × status × mode <!-- R1, R6 -->
- [x] T014 Add tests: tolerant legacy engine file (R3), migration leaves `merge_seq` PR item (R4), merge-auto barrier held/spawn/escalate/silent (R5), `stop` writes no `halted` (R7), `rm`/`resume` of `pr-41` → exit 2 (R7), `status --json` has no `pr_status`/`fixes` (R8), Q6-style aged spawned item decides no escalation (R1) <!-- R1, R3, R4, R5, R7, R8 -->
- [x] T015 Run `cd app/backend && go build ./... && go vet ./... && go test ./...` (known host-only failures: `TestPortPinRowRealPolicyValues`, `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`) <!-- R2 -->

## Execution Order

- T001–T006 together leave the package compiling; T007 depends on T003/T005; T013–T015 last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `ruleTable` is exactly X0, X1, Q1–Q5, queue-kind only; no PR/fix kinds, statuses, actions or waits exist
- [x] A-002 R2: `merge.go`, `restack.go`, `recovery.go` and their tests are gone; no PR executor or PR observation remains reachable
- [x] A-003 R3: engine file is queue-only; `OwnedIDs` returns queue ids only
- [x] A-004 R4: migration absorbs only queue pane items
- [x] A-005 R5: merge-auto successor is held until the dependency PR reads `MERGED`
- [x] A-006 R6: `autopilot` has seven verbs; `merge` is gone
- [x] A-007 R7: `stop`/`rm`/`resume` behave and are documented as queue-only
- [x] A-008 R8: `status --json` has no `pr_status`/`fixes`; `step` reports queue lines only
- [x] A-009 R9: `changed`/`done` on a `github-pr` item are judgment
- [x] A-010 R10: settings description, chat skill (+ synced copy) and track help carry no deleted-verb wording; `brief_rules.md` unchanged

### Behavioral Correctness

- [x] A-011 R1: a spawned item idle in stage > 30 min and a queue open > 2 h decide no escalation
- [x] A-012 R9: a `done` on a non-PR item without `then` remains non-judgment; queue-item `pane_death` remains mechanical

### Removal Verification

- [x] A-013 R2: no references to `autoMergeAllowed`, `--disable-auto`, compare API, `ActionMerge`, `PRStatus`, `FixStatus`, `StartMerge` remain in `app/backend` (the only `PRStatus` hit is the unrelated `internal/prstatus` sidebar type)
- [x] A-014 R6: no test or help text references `autopilot merge`

### Scenario Coverage

- [x] A-015 R3: a test loads a legacy engine file with `prs`/`fixes` and removed keys, runs a pass, and checks the rewrite drops them
- [x] A-016 R5: tests cover barrier held (OPEN), satisfied (MERGED), read failure escalation in step, and silence in status
- [x] A-017 R7: tests cover `stop` pausing without `halted`, and `rm`/`resume` of an unknown/PR id exiting 2

### Edge Cases & Error Handling

- [x] A-018 R5: a merge-auto dependency with no recorded branch escalates once and the successor stays held
- [x] A-019 R3: a missing engine file still reads as an empty engine

### Code Quality

- [x] A-020 Pattern consistency: remaining code follows the package's existing naming, guarded-write and escalation patterns
- [x] A-021 No unnecessary duplication: the barrier read reuses `viewPR`/`noPRFound` rather than a new gh helper
- [x] A-022 Readability: no dead symbols, dormant branches or comments narrating the removal
- [x] A-023 Subprocess safety: every remaining gh/git call goes through the engine's `Runner` (argv slices, per-class timeouts)
- [x] A-024 Tests: changed behavior (barrier, tolerant read, judgment rows, verbs) has tests; `go test ./...` passes except the two known host-only failures

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `app/backend/internal/autopilot/gate.go:92` `depPRExists` / `gate.go:108` `depMerged` — near-identical branch-check + `viewPR` + `noPRFound` bodies; could fold into one helper returning the `prView` (differs only in the read-only no-PR handling and the `state` test)
- `app/backend/internal/operator/brief_rules.md:17` "Escalation notes are the engine's … never perform the restack or recovery they name" — names engine work that no longer exists (T4 owns the edit; listed so T4 does not miss it)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | F2 and PR-kind X0/X1 deleted with the lists they served | Intake #3 | S:70 R:80 A:85 D:85 |
| 2 | Confident | merge-auto barrier = per-pass `gh pr view <branch> --json url,state` MERGED, reusing `viewPR`/`noPRFound` | Intake #4; non-monotone facts are never stored | S:65 R:70 A:80 D:75 |
| 3 | Confident | `rm`/`resume` of a former PR id is an unknown-id usage error (exit 2) | PR ids are no longer engine items | S:70 R:85 A:80 D:80 |
| 4 | Confident | Skill topic edited minimally; `brief_rules.md` untouched | Intake #8 resolved toward the narrowest edit satisfying Rule 5 | S:60 R:85 A:70 D:65 |
| 5 | Confident | Helpers left unused by the deletion (`nameWithOwner`, `withRepo`, `Panes.Send`, …) are deleted only when the compiler/vet show no caller | Rule 7 + parsimony | S:70 R:85 A:85 D:80 |

5 assumptions (0 certain, 5 confident, 0 tentative).
