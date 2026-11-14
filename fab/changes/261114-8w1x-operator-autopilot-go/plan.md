# Plan: Operator Autopilot in Go

**Change**: 261114-8w1x-operator-autopilot-go
**Intake**: `intake.md`

## Requirements

### Settings: operator.merge_mode

#### R1: Registry key
The settings registry SHALL carry an enum key `operator.merge_mode` (category `behavior`, UI-visible, options = the three merge modes, default `cherry-pick-ladder`, omitted from the file at default). Apply SHALL reject an invalid value; a hand-edited invalid value SHALL be preserved on read so the queue verb can refuse it by name.

- **GIVEN** a config with `operator.merge_mode: stacked-prs` **WHEN** settings load **THEN** `ReadValue` returns `stacked-prs`
- **GIVEN** `operator.merge_mode: bogus` on disk **WHEN** `ApplyValue` is called with `"bogus"` **THEN** it errors naming the valid set

### Autopilot: queue

#### R2: Queue verb
`autopilot.Enqueue` SHALL persist N pending `pane` items in one locked write, resolving the mode by `--mode` > setting > `cherry-pick-ladder`, stamping `scope.merge_mode` on every item, applying implicit chaining (nearest same-repo predecessor, else the previous entry; merge-auto: previous entry as ordering barrier only), validating ids/repos/deps (no bare deps, no duplicates, absolute git-root repos), and reporting the `merge-auto` + explicit same-repo `depends_on` misfit.

- **GIVEN** entries ab12(foo), cd34(bar), ef56(foo) **WHEN** queued **THEN** cd34.depends_on=[ab12] and ef56.depends_on=[ab12]
- **GIVEN** an entry depending on a bare entry **WHEN** queued **THEN** the call is rejected and nothing is written
- **GIVEN** an invalid setting value and no `--mode` **WHEN** queued **THEN** an error names the valid modes

#### R3: Derived state
Queue item state SHALL derive as `done` › `paused` › `held` › `pending` › `spawned`; a stored null mode reads as `cherry-pick-ladder`. The precedence is strict: an item with any unsatisfied `depends_on` is `held` even when it already has a pane.

### Autopilot: readiness gate

#### R4: Dependency satisfaction
A dependency is satisfied when done (fab item: `done_at`; change-less item: open PR with passing checks or merged PR, persisted as `done_at`), plus — for a same-repo dep with null `stop_stage` — an existing PR. A dep surviving only in `branch_map` passes; an unknown dep id is unsatisfied.

- **GIVEN** a same-repo dep that is done but has no PR **WHEN** the dependent is evaluated **THEN** it stays held
- **GIVEN** a dep only in `branch_map` **THEN** the gate passes

### Autopilot: spawn

#### R5: Fetch-first SHA pin
Spawn SHALL `git fetch origin` in the item's repo; a failed fetch is a hard stop (item stays pending, an escalation is emitted, `rev-parse` is never consulted). The default branch resolves via `origin/HEAD` (verified) → `gh repo view` → `main`/`master` probe, and the worktree base is the SHA of `origin/<default>`, so the branch has no upstream tracking.

#### R6: Dependency code by mode
For the same-repo dependency subset: `cherry-pick-ladder` prunes ancestor deps, skips deps already ancestors of HEAD, cherry-picks `origin/<default>..<dep>` with `--no-commit` + a commit, and on conflict aborts, rolls the worktree back, escalates and opens no tab; `stacked-prs` cuts from the SHA of `origin/<dep-branch>` and records the base (`fab status set-base-branch`, a trailing prompt instruction for raw-text fab entries, or the PR-base instruction for plain agents); `merge-auto` bases on `origin/<default>` independently. Cross-repo deps are gate-only. A missing dep branch escalates and does not spawn.

#### R7: Prompt, session, attach
The prompt follows the two-axis table (fab present × task); the target repo's agent resolution is used; the tab opens in the role-aware landing session; the item's scope (`pane`, `session`, `branch`) and `branch_map` are attached in one locked write merged by item id. A confidence score below 3.0 on an existing change blocks the spawn with an escalation.

#### R8: Respawn
A spawned item whose pane is gone gets one existing-branch respawn, recorded as `scope.respawned: true` before acting; afterwards it is skipped with an escalation and dependents stay held.

### Autopilot: merge

#### R9: Ordered merge
`merge` SHALL start per-repo `github-pr` sequences for completed `cherry-pick-ladder`/`stacked-prs` queues (refusing while items are not done; no-op for merge-auto). `cherry-pick-ladder` follows the five Auto-Merge rules (sequential arming, arming-failure shapes with explicit `--squash`, stall rule, items-are-the-sequence, cone-scoped disarm); `stacked-prs` never arms and direct-merges on each `step` when checks are green and `MERGEABLE`, then verifies/edits the base retarget and rebases `--onto` with `--force-with-lease`, halting on conflict. Merges without a non-PENDING review are reported `· unreviewed` with a summary line.

#### R10: merge-auto
When a merge-auto item ships, `step` creates and arms its `github-pr` item; the next queue item stays held until that merge is verified, then spawns on the advanced tip. A halt disarms that one PR and escalates.

### Autopilot: recovery, stop, status

#### R11: PR Recovery
`ci-failed` writes `scope.recovery="ci-fix"` + `fix_head` before sending the fix request to the authoring pane (found by derived change), keeping the PR armed; pane gone → one recovery spawn tracked as `<change>-fix`; red on a new head or 30 min with no push halts the cone and disarms. `conflicting` writes `scope.recovery="rebase"` before `fetch && rebase && push --force-with-lease` and re-arm; `CONFLICTING` again or a rebase conflict aborts, disarms and halts.

#### R12: Stop and status
`stop` disarms every armed PR and pauses every unspawned queue item, leaving live panes. `status` is a read-only per-item view with the Queue Completion Summary when all items are done.

#### R13: Escalations only
The engine SHALL never notify; failures and halts are structured escalations in the result plus a note on the item.

### CLI

#### R14: `rk operator autopilot`
`queue|step|merge|stop|status` SHALL exist under `rk operator` with `-L/--server`, `--json` envelope, exit classes 0/1/2, shll-conformant help; `step --dry-run` reports a plan with no side effects.

### Spawn engine

#### R15: riff extensions
`riff.Options` SHALL gain additive fields (positional new-branch name, existing-branch checkout, post-worktree hook with rollback on error) and exported worktree create/delete helpers; existing callers stay byte-identical.

### Concurrency

#### R16: Lock discipline
The state lock SHALL never be held across a subprocess; writes merge by item id so an external write between load and write survives.

### Chat skill

#### R17: Chat topic
The `rk skill operator` queue section SHALL route queues through `rk operator autopilot queue`, merge-all through `merge`, stop through `stop`; `brief_autopilot.md` is untouched.

### Non-Goals
- Daemon loop calling `step` — deferred (R7/M1).
- MCP tools for the verbs.

## Tasks

### Phase 1: Foundations

- [x] T001 Add `operator.merge_mode` entry + `Settings.OperatorMergeMode` + tests in `app/backend/internal/settings/settings.go`, `settings_test.go`, `registry_test.go` <!-- R1 -->
- [x] T002 [P] Export helpers (`ItemDone`, `ScopeString`, `NewPaneItem`, `ValidateDeps`, `ErrNoWrite`, `BuiltInCompleted`, `SnapshotPanes`) in `app/backend/internal/operator/export.go` <!-- R2 --> <!-- rework: unused exported ScopeInt wrapper (export.go:22) — delete --> <!-- rework: cycle2: unused PaneScope/ValidateNote in export.go — delete -->
- [x] T003 [P] riff extensions: `WorktreeBranch`, `CheckoutBranch`, `PrepareWorktree`, `CreateWorktree`/`DeleteWorktree` in `app/backend/internal/riff/riff.go` + tests <!-- R15 --> <!-- rework: cycle2: riff skill-prefix renderer must handle a multiline stacked raw-text fab-new prompt (shell.go:81-97) -->

### Phase 2: Engine

- [x] T004 `internal/autopilot/runner.go`: Runner seam, ExecRunner with per-class timeouts, ExecError <!-- R5 -->
- [x] T005 `internal/autopilot/queue.go`: Entry, mode ladder, Enqueue, implicit chaining, validation <!-- R2 --> <!-- rework: strict stdin parser must reject trailing JSON values and cap overflow (queue.go:54, operator_autopilot.go:323) --> <!-- rework: cycle2: reject forward/cyclic depends_on at enqueue (queue.go:219-229); safeBranch must match git check-ref-format --branch (repo.go:126-135) -->
- [x] T006 `internal/autopilot/gate.go`: derived state, readiness gate, repo classification, done_at persistence <!-- R3 R4 -->
- [x] T007 `internal/autopilot/spawn.go`: fetch/default branch/base SHA, confidence gate, dependency code, prompt table, attach, respawn <!-- R5 R6 R7 R8 --> <!-- rework: cycle2: rendered prompt prefix for stacked raw-text (spawn.go:290-296); respawn must keep stacked base (spawn.go:421-425) -->
- [x] T008 `internal/autopilot/merge.go`: ordered merge, auto-merge choreography, stacked-prs step merge, merge-auto, unreviewed reporting <!-- R9 R10 --> <!-- rework: merge --repo drops cross-repo barrier (merge.go:54/129); stacked successor merged on a stale prView after retarget/rebase/push (merge.go:376/469) --> <!-- rework: cycle2: stacked directMerge must gh pr ready drafts first; startChains must surface mutation errors; pr-<repo>-N fallback id collision (merge.go) -->
- [x] T009 `internal/autopilot/recovery.go`: ci-failed and conflicting recovery <!-- R11 --> <!-- rework: cycle2: stall must not panic when an external writer removed the item (recovery.go:44-50) -->
- [x] T010 `internal/autopilot/step.go`: Step/Stop/Status orchestration, escalations, lock discipline <!-- R12 R13 R16 --> <!-- rework: status drops null-merge_mode items (step.go:165); note truncation must be rune-safe (autopilot.go:296); unused ActQueued (autopilot.go:199) --> <!-- rework: cycle2: inQueue drops spawned single-item null-mode queue items (step.go:203-219) -->

### Phase 3: CLI and text

- [x] T011 `cmd/rk/operator_autopilot.go`: verbs, receipts, production seams, registration <!-- R14 -->
- [x] T012 Chat skill topic update in `app/backend/cmd/rk/skill/operator.md` (+ `docs/site/skill/operator.md` mirror when present) <!-- R17 --> <!-- rework: chat skill swaps merge-auto/stacked-prs glyphs, omits the three diagrams, says status emits escalations (operator.md:93/105 + docs/site mirror) -->

### Phase 4: Tests

- [x] T013 `internal/autopilot/*_test.go` with real temp git repos and scripted gh/fab/wt fakes covering every intake sharp edge <!-- R2 R4 R5 R6 R7 R8 R9 R10 R11 R16 --> <!-- rework: cycle2: unused countActions helper in harness_test.go:547 -->
- [x] T014 `cmd/rk/operator_autopilot_test.go` <!-- R14 -->
- [x] T015 `just test-backend` green <!-- R1 R14 -->

### Phase 5: Review cycle 3

- [x] T016 `internal/autopilot/gate.go` `derivedState`: apply the strict precedence `done` › `paused` › `held` › `pending` › `spawned` — an unsatisfied dependency makes the item `held` even when a pane exists; fix `gate_test.go:11-38`, which encodes the wrong order <!-- R3 -->
- [x] T017 `internal/autopilot/merge.go` `arm` + `step.go` `stop`: persist the armed marker durably BEFORE `gh pr merge --auto` (e.g. `scope.armed` written first, like `scope.recovery`); if the gh call then fails, clear it; if any marker write fails, do not report success — and if gh already armed the PR, immediately `gh pr merge --disable-auto` and escalate. `stop` must disarm every PR item carrying the marker (including one whose arm outcome is uncertain). Tests for each failure ordering <!-- R9 R12 R16 -->
- [x] T018 `cmd/rk/skill/operator.md:105` + `docs/site/skill/operator.md:105`: reword merge-auto so it no longer says "nothing is held" — each successor stays held until its predecessor's merge is verified <!-- R17 -->
- [x] T019 `just test-backend` green after T016–T018 <!-- R1 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `operator.merge_mode` is in the registry as a UI enum and validates on write
- [x] A-002 R2: `queue` persists chained pending items with the stamped mode in one write
- [x] A-003 R4: the readiness gate enforces done + PR existence for same-repo deps
- [x] A-004 R5: spawn fetches first, pins the SHA and stops on fetch failure
- [x] A-005 R6: dependency code is handled per mode with conflict rollback
- [ ] A-006 R9: ordered merge implements the five rules and the stacked-prs step merge — Not met: an unknown/transport failure from `gh pr merge --auto` clears `scope.armed` even though GitHub may have accepted the request; stacked rebase/halt paths also acknowledge side effects after ignoring marker-write failures.
- [x] A-007 R10: merge-auto defers the next spawn until the merge is verified
- [x] A-008 R11: PR Recovery writes its marker before acting and is bounded
- [x] A-009 R14: `rk operator autopilot` verbs exist with JSON envelopes
- [x] A-010 R15: riff gains additive options with unchanged existing behavior
- [ ] A-011 R17: the chat topic routes through the new verbs — Not met: it tells chat to run a live `queue`, ask on a returned misfit, and re-run with `--mode`, but the first call already persisted the ids so the second call is rejected.

### Behavioral Correctness

- [x] A-012 R5: the spawned branch carries no upstream tracking config
- [ ] A-013 R16: an external state write between load and write survives; no subprocess runs under the lock — Not met: spawn has no durable claim/CAS; concurrent steps can spawn the same pending item and `attach` blindly overwrites an externally attached pane.

### Scenario Coverage

- [x] A-014 R6: cherry-pick conflict aborts, rolls back, opens no tab, and escalates
- [ ] A-015 R9: disarm hits only the halted cone; global stop disarms everything — Not met: an uncertain `gh pr merge --auto` result clears the durable marker even when GitHub may have armed the PR, so global stop can miss it.
- [x] A-016 R8: a dead pane is respawned once, then skipped

### Edge Cases & Error Handling

- [x] A-017 R2: invalid setting value, bare dependencies, duplicate ids and relative repos are rejected before any write
- [x] A-018 R13: the engine emits escalations and notes and never notifies
- [x] A-024 R3: a spawned item with an unsatisfied dependency derives as `held`, not `spawned`
- [ ] A-025 R9: no PR is ever auto-merge-armed on GitHub without a durable marker `stop` can see; a failed marker write never reports success and leaves the PR disarmed — Not met: after a transport/unknown `gh` failure, the implementation clears the marker without proving that auto-merge was not enabled.
- [x] A-026 R17: the chat skill's merge-auto explanation matches the held-until-verified-merge behaviour

### Code Quality

- [x] A-019 Pattern consistency: new code follows surrounding Go naming, error and envelope patterns
- [ ] A-020 No unnecessary duplication: operator, riff, settings, fabstatus and inject utilities are reused — Not met: autopilot hand-parses `git worktree list --porcelain` instead of reusing the existing `internal/gitinfo` parser.
- [x] A-021 Every subprocess is an argv-slice `exec.CommandContext` with a timeout
- [x] A-022 Comments state constraints only and cite no change IDs

### Security

- [x] A-023 R2: repo paths and ids are validated before any exec; no shell strings

## Notes

- Check items as you review: `- [x]`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `operator.merge_mode` is stored as a flat dotted registry key (`operator.merge_mode: …`) like `gui.*`/`openai_mcp.*`, default `cherry-pick-ladder` omitted at default; the "setting" source is reported when the stored value differs from the default | The registry is flat; the enum select falls back to the registry default, so an unset sentinel would render blank | S:80 R:75 A:85 D:70 |
| 2 | Confident | `settings` cannot import `operator` (tmux→settings cycle), so the valid mode list is duplicated in `settings` and pinned equal to `operator.MergeModes` by a test | Import cycle is real | S:85 R:85 A:90 D:80 |
| 3 | Confident | Queue-only scope keys `task`, `bare`, `respawned`, `skipped`, `recovery`, `fix_head`, `merge_seq` live in the free-form `scope` map | Scope is an open map; the pinned eleven keys stay unchanged | S:85 R:80 A:85 D:80 |
| 4 | Confident | The authoring pane is found through the operator pane snapshot's derived change (`fabstatus.Memo`), which is where per-pane change derivation actually lives (not `internal/sessions`) | Verified in code | S:90 R:85 A:90 D:85 |
| 5 | Confident | The recovery send refuses an `active` pane: the marker is rolled back and the action defers to the next `step` | Never interrupt a working agent (mux send gate) | S:75 R:70 A:75 D:65 |
| 6 | Tentative | Respawn triggers only on a pane id absent from the snapshot (`pane_death`); `agent_exited` respawn is left to the user via escalation | The process-tree walk is lock-free phase-1 work in Check; duplicating it here is out of scope | S:60 R:70 A:60 D:55 |
| 7 | Confident | `status` derives held/pending from stored state only (no gh calls); the live gate runs in `step` | Read-only verb must be cheap and side-effect free | S:80 R:85 A:80 D:70 |
| 8 | Confident | `riff.Spawn` renders skill-shaped tasks (`/fab-fff x`) through the resolved prefix, so the engine passes canonical `/` forms | Existing `ApplySkillPrefix` seam | S:90 R:90 A:90 D:90 |
| 9 | Confident | An existing worktree for a branch is reused by opening the window in `Where=checkout` rooted at that worktree | Git refuses a second checkout of a branch | S:75 R:75 A:75 D:65 |
| 10 | Confident | `stop` and every halt mark the unfinished `github-pr` items `scope.halted: true`; resuming is `rk operator track update <id> --scope '{"halted":false}'` | Without a durable flag the next `step` would re-arm a disarmed PR, defeating the stop | S:80 R:70 A:80 D:65 |
| 11 | Confident | The `unchanged ≥ 3` stall clock is advanced by `step` itself (each pass polls the head PR and records it through `operator.Observe`), alongside the daemon's own probes | Check's probes only run on the daemon cadence; the engine must not depend on them to detect a stall | S:75 R:75 A:75 D:65 |
| 12 | Confident | A recovery spawn's tracking item carries `scope.fix_for` and is excluded from queue handling (no spawn, respawn, or status row) | It is a change-less agent owned by the recovery round, removed when the round resolves | S:80 R:80 A:80 D:70 |
| 13 | Confident | Branch names, PR numbers and change references read from the state file are validated (no leading `-`, no whitespace/ref-syntax characters, digits-only PR numbers) before reaching a git/gh/fab argv | The state file is shared with other writers; Constitution I treats it as input | S:85 R:90 A:85 D:80 |
| 14 | Confident | A queue-created PR item is `pr-<n>` (or `pr-<repo>-<n>` on a number clash across repos), its sequence id is `<repo-basename>-<hash>`, and a PR that already merged is created done so the chain behind it is not blocked | The intake fixes `pr-<n>` and `merge_seq` without naming the collision rule | S:75 R:80 A:75 D:65 |
| 15 | Confident | `rk operator autopilot merge` and `stop` author notes as `chat`; `queue` defaults `--by chat`, `step` defaults `--by run` | The intake lists `--by` only for queue and step | S:75 R:85 A:75 D:70 |

15 assumptions (0 certain, 14 confident, 1 tentative).
