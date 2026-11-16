# Plan: Autopilot status and rule table (R6r-i)

**Change**: 261116-qtgq-autopilot-status-rule-table
**Intake**: `intake.md`

<!-- Binding source: fab/plans/sahil/26-11-16-operator-autopilot-restructure.md (Decisions, Engine model, Rules for the operator, State-file keys, Briefs › R6r-i). Where the intake and the plan disagree the plan wins unless an Assumptions row below says why not. -->

## Requirements

### Autopilot engine: pass shape

#### R1: Observe → derive → decide → execute
`Step` (signature unchanged, pass lock unchanged) SHALL run four stages in `internal/autopilot/`: **observe** (load the ledger, one pane snapshot, one fact read per actionable item), **derive** (a queue status and a PR status per item, first match, pure), **decide** (`decide(state, facts, now) []Decision`, pure, no I/O, no `ctx`, at most one row per item, first match in table order) and **execute** (one executor per typed action, in ledger order). No action sees another action's effect in the same pass.

- **GIVEN** a queue whose item `a` just completed and whose dependent `b` is derived `pending`
- **WHEN** one `step` runs
- **THEN** `a`'s `record-done` and `b`'s `spawn` are both decided from the one snapshot, executed in ledger order, and no row reads a value an executor of the same pass wrote

#### R2: `decide` is pure and the rule table is data
`decide` SHALL take only a ledger snapshot, the observed facts and `now`, perform no I/O, and walk a package-level rule table (`{id, kind, status, guard, action}`) so a test can iterate it. Every (item kind, merge mode, status) maps to a row or to an explicit wait entry; a combination with neither is reported by `decide` as an unmatched decision, never silently acted on.

- **GIVEN** any queue status, PR status and merge mode in `{cherry-pick-ladder, merge-auto, stacked-prs}`
- **WHEN** `decide` runs on a fixture for that combination (no git, no `gh`, no tmux)
- **THEN** it returns exactly one decision for the item: the row that fires, or an explicit wait

#### R3: Executors act on a re-read item
Before each action the executor SHALL re-read its item under the store lock (or, for a non-writing action, immediately before the `gh` call) and skip it, escalating `PR item <id> changed externally; skipped`, if the item vanished or its decision-input fingerprint changed since observe. The fingerprint excludes `updated_at`, `last`, `unchanged`, `checked_at`, `failures`, `seen`, `notes` and the check-owned scope keys (`stage`, `agent`, `pane_pid`). A non-idempotent action (`spawn`, `respawn`, `skip`, `halt`, `escalate`) writes its intent first; an idempotent one (`record-*`, `arm`, `disarm`, `ready`, `merge`) writes nothing the next pass cannot re-derive.

- **GIVEN** an item decided `arm` whose `probe` or `scope.pr` is edited externally between observe and execute
- **WHEN** the executor runs
- **THEN** no `gh` call is made, and an escalation `changed externally; skipped` is returned

### Autopilot engine: derived status

#### R4: Queue item status
For a queue item (`operator.IsQueueItem`) the status SHALL be the first match of: `done` (`done_at` set, or completion observed: fab `ship`/`stop_stage` through `operator.BuiltInCompleted` on rk's pane row, or a plain agent's branch PR `MERGED`, or `OPEN` with required checks not pending) › `paused` › `skipped` › `held` (a `depends_on` item not satisfied: not done, a same-repo dependency without `stop_stage` that has no PR, or — `merge-auto` — a dependency whose PR item has not merged; `branch_map`-only dependencies count as satisfied) › `pending` (no pane, no `spawning`) › `spawn-unknown` (`spawning` set and no live pane) › `spawned` (pane alive) › `dead` (pane recorded, not alive). A dependency's `done` is the stored `done_at` or the same observed completion.

- **GIVEN** queue `a ← b` and `a` has a live pane at the `ship` stage `done`
- **WHEN** statuses are derived
- **THEN** `a` is `done` and `b` is `pending`
- **GIVEN** an item with a pane recorded that is not in the pane snapshot and whose dependency is not done
- **THEN** its status is `held` (held precedes `dead`)

#### R5: PR item status
For a `github-pr` item with `scope.merge_seq` the status SHALL be the first match of: `merged` (`gh` state `MERGED`, or `done_at`) › `halted` (stored `halted` on the item or on any not-done item it transitively `depends_on`; the cone is derived, never written) › `closed` (`gh` state `CLOSED`) › `deferred` (stored) › `blocked` (a `depends_on` item is not done) › `draft` › `failed` (a required check is `FAILURE`) › `conflicting` (`mergeable == CONFLICTING` and `unchanged ≥ 3`) › `green` (no required check failing or pending, `mergeable == MERGEABLE`) › `waiting` (anything else, including a failed fact read). `stale-base` and `fixing` are not added.

- **GIVEN** PR `p1` halted and PR `p2` depending on `p1`, and `gh` reports `p2` `OPEN`
- **THEN** `p2` is `halted`; **AND** if `gh` reports `p1` `MERGED` its status is `merged` (merged beats halted)
- **GIVEN** `mergeable == CONFLICTING` with `unchanged == 2`
- **THEN** the status is `waiting`; with `unchanged == 3` it is `conflicting`

#### R6: Observe reads facts only for items that can act
Observe SHALL read, once per pass: the pane snapshot; for each unfinished queue item with a pane recorded its completion facts (plain agent: PR state and required checks); for each item with unmet-looking readiness its same-repo dependency PR existence; for each merge sequence its head (first not-done PR item) unless the head is `deferred` or blocked, and every not-done PR item of a halted cone. A PR fact read is `gh pr view <n> --repo <nwo> --json number,url,state,isDraft,mergedAt,mergeable,headRefOid,autoMergeRequest` plus `gh pr checks <n> --required --json name,state,link` (only when the status reaches the check statuses); the repo fact is `gh repo view <nwo> --json autoMergeAllowed`, cached per repo per pass, read only for a PR that is `waiting` and unarmed. A failed read escalates (`gh pr view failed: …`) and the item is `waiting`/unknown for the pass. A sequence head's polled `state`/`mergedAt`/`mergeable` is still written through `operator.Observe` (the `unchanged` clock), skipped under `--dry-run`. The predecessor of a head is not read: no R6r-i row consumes it.

- **GIVEN** a head PR whose `gh pr view` fails
- **WHEN** `step` runs
- **THEN** it escalates `gh pr view failed: …`, takes no action on that PR, and no other item's action is blocked

### Autopilot engine: rules

#### R7: Queue rows Q1–Q7
The rule table SHALL contain: Q1 queue·`done`, `done_at` unset → `record-done`; Q2 `pending` → `spawn` (writes `spawning`); Q3 `spawn-unknown`, not yet escalated → `escalate` `spawn interrupted: …` once; Q4 `dead`, respawn unspent → `respawn` (writes `respawned` and `spawning`); Q5 `dead`, respawn spent → `skip` + `escalate` (writes `skipped`); Q6a `spawned`, stage unchanged 30 min, not yet escalated → `escalate` once; Q6b the oldest unfinished queue item (any status but `done`, after every other row for that item), queue open 2 h, not yet escalated → `escalate` once; Q7 `done`, `merge-auto`, not bare, `done_at` set, no PR item → `track-pr`. Every other queue status is an explicit wait.

- **GIVEN** a `merge-auto` item newly observed done
- **WHEN** pass 1 runs **THEN** Q1 fires; **WHEN** pass 2 runs **THEN** Q7 fires and creates its one-PR sequence
- **GIVEN** a held oldest item open for over 2 h **WHEN** `step` runs **THEN** Q6b escalates `queue open for over 2h0m0s` once

#### R8: PR rows P1–P7
The rule table SHALL contain: P1 `merged`, `done_at` unset → `record-merged`; P2 `closed` → `halt`; P3 `halted`, armed → `disarm`; P4 `draft`, not `stacked-prs` → `ready`; P5 `failed`/`conflicting`, not yet escalated for this head → `escalate` `recovery needed: <ci-failed|conflicting> — PR #<n> (<repo>)`; P6 `waiting`, not `stacked-prs`, repo allows auto-merge, not armed → `arm`; P7 `green`, not `stacked-prs`, not armed → `merge` (squash). Every other PR status, and every non-P1–P3 status of a `stacked-prs` item, is an explicit wait. A `merge`/`arm` of a halted, failed or conflicting PR never happens.

- **GIVEN** a `green` unarmed PR in a repo with auto-merge disabled
- **WHEN** `step` runs
- **THEN** P7 merges it with `gh pr merge --squash` and no `--auto` call is made
- **GIVEN** a PR that is `failed`
- **THEN** P5 escalates once per head SHA and neither P6 nor P7 fires

#### R9: Escalate-once uses `scope.escalated`
Every escalate-once row (Q3, Q6a, Q6b, P5) SHALL guard on, and write, the `scope.escalated` map keyed by the reason (P5: reason plus the head SHA). `scope.stall_seen` SHALL NOT be read or written.

- **GIVEN** a PR failed on head `X` that was escalated
- **WHEN** the next pass runs on head `X` **THEN** no new escalation; **WHEN** head becomes `Y` and still fails **THEN** it escalates again

### Autopilot engine: derived facts and intentional deltas

#### R10: Armed is derived; a halt disarms the whole cone
Armed SHALL be `autoMergeRequest != null` from `gh pr view`; `scope.armed` SHALL NOT be read or written. `stop` and `halt` SHALL disarm every armed PR in the halted cone whoever armed it, P3 retrying every pass until GitHub reports it disarmed. A halt SHALL write `halted` on one item only; clearing it resumes the cone.

- **GIVEN** a person armed PR 2 in a sequence halted at PR 1
- **WHEN** `step` runs **THEN** PR 2 is disarmed by P3 and no `halted` key was written on PR 2
- **GIVEN** a failed disarm **WHEN** the next `step` runs **THEN** P3 retries it

#### R11: Repo auto-merge is a fact
Repo auto-merge SHALL come from `gh repo view --json autoMergeAllowed`, never a stored `direct` key. The stored `direct` key, the arm-rejection fallbacks (`clean status` → merge, `auto merge is not allowed` → `direct`), `definitiveArmRejection`, `markArmed`, `directMerge`, `driveHead`, `advanceSeq`'s guard loop, `retryDisarms`, `haltCone`'s cone-wide write, `stall` and the `flagSlow`/`observeDone`/`spawnPending`/`respawnDead`/`escalateInterrupted` phase loops SHALL be removed. Old `armed`, `direct`, `stall_seen` values on disk are tolerated and never rewritten.

- **GIVEN** a repo whose `autoMergeAllowed` is false and a PR that is `waiting` **THEN** the row is an explicit wait (no failed arm attempt); once `green` P7 merges it and no `auto-merge is disabled` escalation appears

#### R12: A failed or conflicting PR is never armed first
Status SHALL be derived before any arm, so a `failed` or `conflicting` PR matches P5, never P6.

#### R13: A sequence advances one PR per pass
P1 records a merge; the successor is observed and armed or merged on the next pass.

- **GIVEN** a two-PR sequence whose head PR is `MERGED` on GitHub
- **WHEN** one `step` runs **THEN** PR 1 is recorded done and PR 2 is not armed or merged in that pass; **WHEN** the next `step` runs **THEN** PR 2 is acted on

### Verbs and CLI

#### R14: `merge` and `stop` write intent, then run one pass
`StartMerge` SHALL keep its validation, the `stacked-prs` refusal (`errStackedMerge`) and its intent writes (PR chains, lifting `deferred`) then run one pass; it SHALL NOT call an advance loop. `Stop` SHALL write only `halted` on every not-done PR item and `paused` on every unspawned unfinished queue item, then run one pass in which P3 disarms every armed PR; it SHALL NOT read an `armed` marker.

- **GIVEN** an armed PR and an unspawned queue item **WHEN** `stop` runs **THEN** the PR item carries `halted`, the queue item `paused`, and the PR is disarmed in the same call

#### R15: `status` shows derived status names
`status` (read-only, no lock, no writes, no escalations) SHALL run observe + derive and show queue status names in `state` (`done`, `paused`, `skipped`, `held`, `pending`, `spawn-unknown`, `spawned`, `dead`), and for a row with a PR item the PR item's status (`PR #12 · green · 1/3`); the JSON keeps `state` and adds `pr_status`. Derived statuses are not exposed to `done_when`.

- **GIVEN** a queue item with a green PR item **WHEN** `status` runs **THEN** the line contains `PR #<n> · green · 1/1` and `--json` carries `"pr_status":"green"`

#### R16: `step --dry-run` prints `decide`'s output
`--dry-run` SHALL take no lock, write nothing, execute nothing, and render each decision as an action carrying the typed action name, the item and the row id (e.g. `dry-run: spawn ab12 (Q2)`); waits are not listed.

#### R17: `track rm` refuses a not-done sequence PR item
`operator.Remove` SHALL refuse `track rm` of any not-done `github-pr` item with `scope.merge_seq` set (an engine sequence PR that may be armed) unless `--force`, naming `gh pr merge --disable-auto`; the refusal no longer depends on `scope.armed`.

- **GIVEN** a not-done `github-pr` item with `merge_seq` and no `armed` key **WHEN** `track rm` runs without `--force` **THEN** it is refused; **WHEN** the item is done or lacks `merge_seq` **THEN** it is removed

### Non-Goals

**Review bar** (quote it in every review dispatch prompt):

> **Must-fix**: anything that can merge, arm, push, force-push or delete the wrong thing; lose or corrupt state-file data; launch a duplicate agent *under the single-writer rule*; crash the CLI; or break a requirement in the step's plan. **Should-fix** (does not block): failure cases the pass lock rules out, tmux pane-id reuse, missing escalations for read-only probes, and cosmetics. From R6r-ii, a finding that needs an external write to the engine file (a hand edit) is out of scope.

**Plan rule 6**:

> From R6r-i on, autopilot behaviour is added only as a status case, a rule row and an executor. A `decide` table test enumerates every reachable (item kind, merge mode, status) and asserts the row that fires, or an explicit `wait`. A behaviour outside the table, or a reachable combination with no outcome, is must-fix.

**Plan rule 7**:

> From R6r-ii on, the engine file is written only under the pass lock. A step never adds an engine key to a ledger item, and never reads a ledger item's `scope` for a decision beyond the projection keys listed in § Engine state file.

(Rule 7 binds from R6r-ii; for R6r-i its live half is: no new engine key on a ledger item.)

Out of scope for R6r-i:

- Engine state file, projection items, `rm` / `resume` verbs, deleting the scope allow-list (R28–R33), escalations-as-notes + `rk notify`, the mechanical pass in the run wrapper, judgment-only model runs, brief diet — all R6r-ii.
- `stale-base` status, row B1, `restack` executor, P7 for `stacked-prs` — R6b. The `stacked-prs` refusal in `merge` stays.
- `fixing` status, rows C1–C6, F1, `fix-request` / `recovery-spawn` / `rebase` / `untrack` — R6c. P5's `recovery needed` escalation stays.
- Any change to `brief_autopilot.md`, `brief_rules.md` or the chat skill; no new verb, no new scope key, no new CLI flag; no `docs/memory/` edit in apply.
- Concurrency handling beyond the pass lock (overlapping passes, claims, CAS) and tmux pane-id reuse (accepted).
- Exposing derived statuses to `done_when`.

### Design Decisions

#### Armed is derived, never stored
**Decision**: Armed is read from `autoMergeRequest` every pass; the engine writes no `armed`, `direct` or `stall_seen`, and keeps old values tolerated on disk.
**Why**: Most R6 review findings were a stored marker disagreeing with GitHub (halted-and-armed, uncertain arm outcome, stale `direct`); deriving removes the marker and the code that protected it.
**Rejected**: Keeping `armed` for `track rm` only — contradicts the stored-vs-derived rule; `track rm` is refused by `merge_seq` instead.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

#### One pure `decide` over a data rule table
**Decision**: Row selection is a pure function over a package-level table; executors never decide; each (kind, status) has a row or an explicit wait.
**Why**: Table tests need no git or `gh` fakes, and R6b/R6c add rows plus executors rather than branches in a driver.
**Rejected**: Keeping `driveHead`/`directMerge` and testing through fakes — each new behaviour re-opens the imperative review loop.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

## Tasks

### Phase 1: Status, facts and rule table

- [x] T001 Add `app/backend/internal/autopilot/status.go`: `QueueStatus`/`PRStatus` types and constants with `allQueueStatuses`/`allPRStatuses`, the `facts` types, and the pure `deriveQueue`/`derivePR` (plus the shared pre-check used by observe to know when checks are needed, and the derived halted cone) <!-- R4, R5 --> <!-- rework: missing PR dependency must block; halted cone must not propagate through an observed-merged upstream -->
- [x] T002 Add `app/backend/internal/autopilot/observe.go`: `observe` (ledger load, pane snapshot, completion/readiness/PR/repo facts, the head `operator.Observe` write, escalations on failed reads), `prView` gains `autoMergeRequest`, `viewPR`/`requiredChecks`/repo-fact readers move here <!-- R6, R10, R11 -->
- [x] T003 Add `app/backend/internal/autopilot/rules.go`: `ActionKind`, `Decision`, the rule table Q1–Q7 (Q6 split) and P1–P7, the explicit wait table, and pure `decide` <!-- R2, R7, R8, R9, R12 -->

### Phase 2: Executors and verbs

- [x] T004 Add `app/backend/internal/autopilot/execute.go`: `execute` (ledger order, fingerprint recheck, guarded writes) and the executors `record-done`, `escalate`, `skip`, `halt`, `disarm`, `ready`, `arm`, `merge`, `record-merged`, `track-pr` <!-- R3, R7, R8, R10, R13 --> <!-- rework: track-pr and escalate writes fingerprint-guarded under the lock; P7 refuses an unpinned merge; PR changed-externally message text -->
- [x] T005 Rework `app/backend/internal/autopilot/spawn.go`: remove `spawnPending`/`respawnDead`/`escalateInterrupted` loops and dry-run branches; `spawnItem`/`respawn` become the `spawn`/`respawn` executors (decisions moved out), `launch`/`attach` keep their marker mechanics <!-- R3, R7 -->
- [x] T006 Dissolve `app/backend/internal/autopilot/merge.go`: keep `StartMerge` (intent then one pass), PR-chain builders, pin/identity helpers, `viewPR`-adjacent helpers; delete `advanceSeq`, `driveHead`, `arm` fallbacks, `directMerge`, `retryDisarms`, `haltCone`, `stall`, `markArmed`, `definitiveArmRejection`, `patchPR`, `stillNamesSamePR` <!-- R11, R14 -->
- [x] T007 Rework `app/backend/internal/autopilot/step.go`: `step` = observe → decide → execute (dry-run renders decisions), `stop` = intent then one pass, `Status` = observe + derive with `StatusItem.PRStatus`; shrink `app/backend/internal/autopilot/gate.go` to the readiness fact helpers; update `autopilot.go` action kinds (`readied`) and `queue.go` scope constants (`armed`/`direct`/`stall_seen` aliases kept only as tolerated-on-disk) <!-- R1, R14, R15, R16 -->
- [x] T008 Update `app/backend/cmd/rk/operator_autopilot.go`: `status` line with PR status, `step`/`stop`/`merge`/`queue` help text for the new pass shape, `renderStep` dry-run lines <!-- R15, R16 -->
- [x] T009 Widen `armedPRItem` in `app/backend/internal/operator/ownership.go` (and its `Remove` message in `track.go`, `track rm` help in `cmd/rk`) to any not-done `github-pr` item with `scope.merge_seq` <!-- R17 -->

### Phase 3: Tests

- [x] T010 Update `app/backend/internal/autopilot/harness_test.go`: `gh pr view` fixtures carry `autoMergeRequest`, `gh repo view` serves `autoMergeAllowed` (per-repo toggle), `stateOf` runs observe + derive <!-- R4, R6 -->
- [x] T011 Add `app/backend/internal/autopilot/rules_test.go`: the `decide` table test (every kind × mode × status plus each guard side, no git/`gh`), a coverage test iterating `allQueueStatuses`/`allPRStatuses` and the rule/wait tables <!-- R2, R7, R8 -->
- [x] T012 Add `app/backend/internal/autopilot/status_test.go`: derive tests (precedence, derived cone through cross-repo `depends_on`, `merged` beats `halted`, `conflicting` needs `unchanged ≥ 3`, `spawn-unknown` with a stale pane) <!-- R4, R5 -->
- [x] T013 Add `app/backend/internal/autopilot/deltas_test.go`: one test per intentional delta (derived armed + cone disarm of a person-armed PR, `autoMergeAllowed` with P7, one-item halt with derived cone, failed/conflicting never armed, one PR per pass) plus a source scan asserting `armed`/`direct`/`stall_seen` are neither read nor written <!-- R10, R11, R12, R13 -->
- [x] T014 Adjust R6a behaviour tests (`merge_test.go`, `lifecycle_test.go`, `escalation_test.go`, `durability_test.go`, `gate_test.go`, `spawn_test.go`, `spawning_test.go`, `queue_test.go`, `revised_rules_test.go`, `scopekeys_test.go`, `ownership_test.go`) only where they assert a delta, a deleted marker or a multi-PR-per-pass advance; delete tests of deleted internals <!-- R11, R13 -->
- [x] T015 Update `app/backend/cmd/rk/operator_autopilot_test.go` (status line, dry-run rendering, help text) and `app/backend/internal/operator/ownership_test.go` / `app/backend/cmd/rk/operator_track_test.go` (the widened `track rm` refusal) <!-- R15, R16, R17 -->

### Phase 4: Gates

- [x] T016 Run `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`, `go test ./internal/operator/ ./cmd/rk/`, `go vet ./...` from `app/backend`, and `just test-backend`; write `.fab-dispatch/qtgq/apply-result.yaml` <!-- R1 -->

## Execution Order

- T001 → T002 → T003 → T004; T005 and T006 follow T004; T007 needs T002–T006; T008 needs T007; T009 is independent.
- T010 precedes T011–T015; T014 needs T004–T007.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `step` is observe → derive → decide → execute and `decide` takes no `ctx` and performs no I/O
- [x] A-002 R2: the rule table is a package-level slice of rows; `decide` returns one decision per item
- [x] A-003 R3: executors skip a changed or vanished item with a `changed externally; skipped` escalation and make no `gh` call
- [x] A-004 R4: queue statuses derive in the table order, including `skipped`, `spawn-unknown` and `dead`
- [x] A-005 R5: PR statuses derive in the table order with the cone derived through `depends_on`
- [x] A-006 R6: facts are read once per actionable item; a failed read escalates and takes no action
- [x] A-007 R7: rows Q1–Q7 (Q6 split) fire per the table, Q1 before Q7
- [x] A-008 R8: rows P1–P7 fire per the table; `stacked-prs` items get P1–P3 and waits only
- [x] A-009 R9: escalate-once rows read and write `scope.escalated`; P5's key includes the head SHA
- [x] A-010 R10: armed is read from `autoMergeRequest`; stop/halt disarm every armed PR in the cone
- [x] A-011 R11: repo auto-merge is read from `autoMergeAllowed`; no `direct`, no arm-rejection fallback
- [x] A-012 R14: `merge` and `stop` write intent and run one pass
- [x] A-013 R15: `status` shows queue and PR status names; `--json` adds `pr_status`
- [x] A-014 R16: `--dry-run` renders each decision with its row id and writes nothing
- [x] A-015 R17: `track rm` refuses a not-done sequence PR item without `--force`

### Behavioral Correctness

- [x] A-016 R12: a failed or conflicting PR is escalated by P5 and never armed
- [x] A-017 R13: a sequence advances one PR per pass
- [x] A-018 R10: a halt writes `halted` on one item; clearing it resumes the cone

### Removal Verification

- [x] A-019 R11: `advanceSeq`'s loop, `driveHead`, `retryDisarms`, `directMerge`, `haltCone`'s cone write, `stall`, `markArmed`, `definitiveArmRejection` and the phase loops are gone, and no `armed`/`direct`/`stall_seen` read or write remains in the engine

### Scenario Coverage

- [x] A-020 R2: the `decide` table test covers every reachable (kind, mode, status) and each guard's true and false side
- [x] A-021 R10: a person-armed PR in a halted cone is disarmed by `stop` and by P3
- [x] A-022 R13: R6a's lifecycle, merge, escalation, spawn and queue tests stay green except where they assert a delta

### Edge Cases & Error Handling

- [x] A-023 R10: a failed disarm escalates `disarming PR #n failed — it may still merge` and is retried next pass; an already-disabled or finished PR counts as done
- [x] A-024 R8: an arm failure escalates `arming PR #n failed: …` and the next pass re-observes `autoMergeRequest`; `alreadyApplied(arm)` is success
- [x] A-025 R3: a PR item without a pinned owner/name is never acted on

### Code Quality

- [x] A-026 Pattern consistency: New code follows naming and structural patterns of surrounding code
- [x] A-027 No unnecessary duplication: Existing utilities (`operator.Mutate`, `escalate`, `alreadyApplied`, `pin`) are reused
- [x] A-028 No god functions: no function over 50 lines without clear reason; the decision lives in the table, not in executors
- [x] A-029 No magic strings: action kinds, statuses and scope keys are named constants; comments state constraints, never narrate or cite change IDs
- [x] A-030 New behaviour ships with tests, and subprocess calls stay `exec.CommandContext` argv slices via the `Runner`

### Security

- [x] A-031 R3: every `gh` mutation targets the pinned `owner/name` and a digits-only PR number from the re-read item

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `app/backend/internal/autopilot/autopilot.go:278` `escalateAs` — its only caller is now `escalate` (escalateRow writes through `recordEscalation` directly); fold it back into `escalate`, or give it the fingerprint parameter and let `escalateRow` call it instead of repeating its result/“note not written” logic.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Rows Q1–Q7 and P1–P7 as the intake/plan draft them; Q6 split into Q6a/Q6b per intake Assumption 9 | Plan allows splitting a row; keeps R6a's `flagSlow` for non-spawned oldest items | S:90 R:75 A:90 D:85 |
| 2 | Confident | `spawn-unknown` is `spawning` set with no **live** pane (including a stale dead pane id left by a crashed respawn) | A crash between the respawn marker and the attach leaves the old pane id recorded; without this the item would be skipped as a second death instead of escalated, a behaviour change from R6a | S:60 R:80 A:70 D:65 |
| 3 | Confident | A halted cone propagates only through not-done items: a done (merged) upstream with a stale `halted` does not halt its downstream | A merged PR cannot hold anything back; propagating through it would strand a sequence the user already resolved by merging | S:55 R:80 A:70 D:60 |
| 4 | Confident | The predecessor of a sequence head is not read in R6r-i | No R6r-i row consumes it (B1 in R6b does); a read with no consumer costs a `gh` call per sequence per pass and adds failure noise | S:60 R:85 A:75 D:65 |
| 5 | Confident | Q6b's "unfinished" means any derived status but `done` (including `skipped` and `paused`) | R6a's `flagSlow` used `!ItemDone`; a skipped oldest item still means the queue is stuck | S:60 R:85 A:70 D:60 |
| 6 | Confident | The head's `Unchanged` is read from a ledger reload taken after observe's `operator.Observe` writes | `conflicting` needs the post-write count R6a's `stall` read; one reload keeps decide pure and avoids duplicating `Observe`'s comparison | S:65 R:80 A:75 D:70 |
| 7 | Confident | Executors continue after one action's hard error and join the errors; the pass returns the joined error | A failed record write must not skip a later disarm (`stop` safety); R6a aborted because its phases were sequential | S:55 R:80 A:70 D:60 |
| 8 | Confident | P7 (`merge`) and P1 (`record-merged`) both report kind `merged`; the `ready` executor adds a `readied` action | The success of `gh pr merge --squash` is a real effect; `ready` reported nothing in R6a, which would leave a pass that readied a draft looking empty | S:55 R:85 A:70 D:60 |
| 9 | Confident | `stop`'s pass is the full pass (a dead-pane respawn can fire in it), not a P-rows-only pass | Intake: `stop` runs "one pass"; a later `step` respawns the same item anyway because `stop` pauses only unspawned items | S:55 R:70 A:65 D:55 |
| 10 | Tentative | Widen `track rm`'s refusal to any not-done `github-pr` item with `merge_seq` (intake Assumption 7), `--force` overrides | The plan's "nothing outside the engine reads `armed`" is false: `ownership.go` `armedPRItem` does; an inert refusal would let a person drop an armed PR the engine could no longer disarm | S:45 R:65 A:45 D:45 |
| 11 | Confident | P7's `gh pr merge --squash` adds `--match-head-commit <observed headRefOid>`; P6 additionally requires the PR's required checks to have been read | A head pushed between the check read and the merge would otherwise merge unverified code (review bar: merge the wrong thing); an arm should not rest on an unread check | S:60 R:85 A:75 D:65 |
| 12 | Confident | `stop` returns an error when a halted-cone PR's armed state could not be read (no pin, bad number, failed view) or a disarm failed; `step` only escalates | R6a's stop failed loudly rather than claiming a disarm it could not place; armed is now an observed fact, so an unreadable one is the same case | S:60 R:80 A:70 D:60 |
| 13 | Confident | The read-only `status` tolerates a failed pane snapshot (recorded panes read as alive) and does not warn on `no pull requests found` for a plain agent's completion lookup | R6a's status never snapshotted panes or read completion; a spawned agent with no PR yet is normal, and a dead tmux must not make `status` exit 1 | S:55 R:85 A:70 D:60 |
| 14 | Confident | A cone halt reaches an upstream-halted PR's armed state one pass later: the pass that writes `halted` disarms the halted item itself, the rest of the cone is observed (and disarmed by P3) on the next pass | The cone is derived from the stored `halted`, which does not exist at observe time; the plan scopes the same-pass disarm to the halted item | S:65 R:80 A:75 D:70 |

14 assumptions (1 certain, 12 confident, 1 tentative).
