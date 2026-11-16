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

### Durability of destructive actions

#### R18: Durable spawn claim
`spawnPending` SHALL claim an item durably before any side effect: under the lock, compare-and-set `scope.claim = {at, token}` only when the item is still unspawned, unpaused and unclaimed (else skip it — another pass owns it). The claim records the spawned window/pane as soon as they exist. `attach` SHALL merge by id and only commit when the item still carries this pass's claim token; if an external writer set a pane meanwhile, the external write wins and the just-created window is reported as an orphan escalation (never silently left running untracked). A failed attach leaves the claim with the recorded pane so the next pass reconciles (adopts a live recorded pane, otherwise releases the claim with an escalation) instead of launching again. A claim older than 15 minutes with no live recorded pane is released with an escalation. No `spawned` action is reported before the attach write succeeds.
- **GIVEN** two overlapping `step` passes **WHEN** both see the same pending item **THEN** exactly one spawns it
- **GIVEN** the attach write fails after the tab opened **WHEN** the next `step` runs **THEN** it adopts the recorded live pane and launches nothing

#### R19: Arm outcome classification
`arm` SHALL keep `scope.armed` set for every `gh pr merge --auto` outcome except a provably definitive rejection, from a closed, tested list: auto-merge not allowed on the repo, PR not in a mergeable/armable state, "clean status" (handled as direct merge). Timeouts, 5xx, network errors and unrecognised errors keep the marker and escalate "arm outcome uncertain"; `stop`'s `--disable-auto` is idempotent and covers them.
- **GIVEN** `gh pr merge --auto` times out **WHEN** `stop` runs later **THEN** it disarms that PR

#### R20: Persist before acknowledge
Every destructive or state-advancing path (merged completion, `scope.prepared` after a stacked rebase/force-push, cone halt `scope.halted`, global stop) SHALL persist its marker before reporting the action as done; where the external action must come first, a failed write is returned as an error/escalation and the success action is NOT emitted. Intent markers are written before the external action wherever the action is idempotent to repeat.
- **GIVEN** the state write fails after a stacked force-push **WHEN** the pass reports **THEN** it reports an escalation, not `rebased`

### Correctness

#### R21: Explicit PR repository
A `github-pr` item SHALL always carry an explicit `owner/name`; when it cannot be resolved, item creation is refused with an escalation. `operator.NewGitHubPRItem` rejects an empty repo instead of omitting `--repo`.
- **GIVEN** `gh repo view` fails **WHEN** a PR item would be created **THEN** none is created and an escalation is emitted

#### R22: Required checks only
A change-less item's completion SHALL use required checks only (`gh pr checks <n> --required`), treating "no required checks" as passing; optional failing/pending checks never block.
- **GIVEN** an optional check fails and required checks pass **WHEN** completion is evaluated **THEN** the item is done

### CLI and chat

#### R23: Bounded human output
Human (non-JSON) output of `queue`, `step`, `merge`, `stop` and `status` SHALL cap each list per the shll toolkit standard (read `shll standards` → the P9/list-cap entry) with an exact total count, a truncation notice and an `--all` escape hatch; `--json` stays complete.
- **GIVEN** more items than the cap **WHEN** `status` prints for a human **THEN** it shows the cap, the exact total and how to see all

#### R24: Misfit-safe queue flow
A live `queue` call SHALL write nothing when the receipt has a misfit and `--mode` was not given explicitly (error naming the misfits); the chat skill (and its docs/site mirror) SHALL run `queue --dry-run` first, confirm mode and misfits with the user, then make exactly one live call. The help's exit-code contract SHALL match the implementation for the already-tracked-id case (pinned by a CLI test).
- **GIVEN** a merge-auto queue with same-repo deps and no `--mode` **WHEN** queued live **THEN** nothing is written

#### R25: Reuse the worktree parser
`worktreeForBranch` SHALL reuse `internal/gitinfo`'s quoted-path/NUL-aware worktree parser (preferably the `-z` form) through the Runner seam instead of a hand parser.
- **GIVEN** a worktree path containing a quote **WHEN** resolved by branch **THEN** the exact path is returned

#### R26: Explicit queue membership
An item SHALL be autopilot queue work (spawned, respawned, listed by `status`, eligible for merge chains) iff it carries `scope.queue` (stamped by `autopilot queue`) OR, for legacy items created before this change, a non-null `scope.merge_mode` OR it participates in a `depends_on` edge with another queue-eligible item. Every other tracked pane — including a bare pane added with `rk operator track add` — is NOT queue work: its pane death/agent exit is completion per §6 and it is never respawned. A legacy single null-mode item with no dependency edges is treated as an ordinary pane (documented trade-off).
- **GIVEN** a bare pane tracked with `rk operator track add` **WHEN** its pane dies **THEN** autopilot never respawns it

#### R27: CI-fix round lifecycle
A `ci-failed` fix round SHALL stay open (fix item, `scope.fix_item`, `fix_head`) while any required check is PENDING or the head SHA has not changed since the request; it is resolved (and the `<change>-fix` item removed) only when every required check on the PR's current head is green, and closed as a halt only by the terminal halt path (red on a new head, or the 30-minute no-push bound).
- **GIVEN** a failed required check that turns pending after the fix push **WHEN** `step` runs **THEN** the fix round and its item remain

#### R28: Validate shared-state branches before mutation
Every branch read from shared state (item scope, `branch_map`, predecessor PRs) SHALL be validated with `safeBranch` and an empty/invalid result rejected with an escalation BEFORE any fetch, retarget, rebase, worktree, push or gh mutation on that path.
- **GIVEN** a malformed `scope.branch` on a stacked successor **WHEN** `step` prepares it **THEN** nothing is fetched, retargeted or rebased and an escalation is emitted

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
- [x] T009 `internal/autopilot/recovery.go`: ci-failed and conflicting recovery <!-- R11 --> <!-- rework: cycle2: stall must not panic when an external writer removed the item (recovery.go:44-50) --> <!-- rework: run2 cycle2: recovery must propagate pane-snapshot errors, claim/record the recovery pane durably, and surface busy-deferral rollback failures -->
- [x] T010 `internal/autopilot/step.go`: Step/Stop/Status orchestration, escalations, lock discipline <!-- R12 R13 R16 --> <!-- rework: status drops null-merge_mode items (step.go:165); note truncation must be rune-safe (autopilot.go:296); unused ActQueued (autopilot.go:199) --> <!-- rework: cycle2: inQueue drops spawned single-item null-mode queue items (step.go:203-219) -->

### Phase 3: CLI and text

- [x] T011 `cmd/rk/operator_autopilot.go`: verbs, receipts, production seams, registration <!-- R14 --> <!-- rework: run2 cycle2: validate merge --repo (absolute, existing, matching a queued repo) — InvalidError otherwise -->
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

### Phase 6: Review run 2 (revise requirements R18–R25)

- [x] T020 `internal/autopilot/spawn.go`: durable spawn claim (CAS), claim-token-guarded attach, orphan/adopt reconciliation, stale-claim release; tests for overlapping passes, attach failure, external pane write <!-- R18 --> <!-- rework: run2 cycle1: revalidate readiness + depends_on atomically with the claim (claim the exact ready snapshot or re-check after claiming, before any side effect); regression test for a depends_on update between gate and claim (spawn.go:45/61/65, claim.go:30) --> <!-- rework: run2 cycle2: respawn and recovery spawns must use the same locked CAS claim as spawn (no double launch, no untracked pane) -->
- [x] T021 `internal/autopilot/merge.go`: closed definitive-rejection list for arm; unknown outcomes keep the marker and escalate; tests incl. timeout/502 then stop disarms <!-- R19 --> <!-- rework: run2 cycle2: disarm must be idempotent (classify already-disabled / not-armed as success) so stop converges -->
- [x] T022 `internal/autopilot/merge.go`, `step.go`: persist-before-acknowledge for merged completion, `scope.prepared`, `scope.halted`, global stop; tests with failing state writes <!-- R20 --> <!-- rework: run2 cycle1: createMergeAutoPRs (merge.go:281) and advanceSeq (merge.go:373) must surface missing branch / gh pr view failures as structured escalations (plus deduplicated notes); tests for both --> <!-- rework: run2 cycle2: every step-path operational error (state reload, Observe, pane snapshot) is a structured escalation, never a silent return -->
- [x] T023 `internal/autopilot/repo.go`, `merge.go`, `internal/operator/export.go`: refuse PR items without resolved owner/name; tests <!-- R21 -->
- [x] T024 `internal/autopilot/gate.go`: required-checks-only completion via the existing required-check query; optional-failing/required-green test <!-- R22 -->
- [x] T025 `cmd/rk/operator_autopilot.go`: bounded human lists + `--all`, exact counts; tests <!-- R23 -->
- [x] T026 `internal/autopilot/queue.go`, `cmd/rk/operator_autopilot.go`, `cmd/rk/skill/operator.md` + `docs/site/skill/operator.md`: misfit-safe live queue, dry-run-first chat flow, exit-code help fix; CLI test for duplicate id <!-- R24 -->
- [x] T027 `internal/autopilot/repo.go`: reuse `internal/gitinfo` worktree parser through the Runner <!-- R25 -->
- [x] T028 `just test-backend` green (also with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1` for `internal/autopilot`) <!-- R1 --> <!-- verified by orchestrator: rk/api TestTerminals_IsoSharedSessionSurvivesFirstClientDeath is a load-timing flake (passes isolated 3/3, full api package passes on branch and on clean origin/main, passes in the next full run); only the host-dependent pre-existing cmd/rk TestPortPinRowRealPolicyValues fails -->

### Phase 7: Review run 2 cycle 3 (revise requirements R26–R28)

- [x] T029 `internal/autopilot/queue.go`, `spawn.go`, `step.go`, `merge.go`: explicit queue membership per R26 — one helper used by spawn, respawn, status and merge-chain selection; regression tests for a bare tracked pane (never respawned), a legacy merge_mode item, a legacy depends_on chain <!-- R26 -->
- [x] T030 `internal/autopilot/recovery.go`: fix-round lifecycle per R27 — no cleanup while any required check is pending or the head is unchanged; failed → pending → green and failed → pending → red-on-new-head regression tests <!-- R27 -->
- [x] T031 `internal/autopilot/merge.go` (prepareStacked), `recovery.go` (conflicting): reject empty/invalid shared-state branches before any external mutation; audit every other `safeBranch` call site for the same ordering; malformed-state tests <!-- R28 -->
- [x] T032 `just test-backend` green + `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1` <!-- R1 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `operator.merge_mode` is in the registry as a UI enum and validates on write
- [x] A-002 R2: `queue` persists chained pending items with the stamped mode in one write
- [x] A-003 R4: the readiness gate enforces done + PR existence for same-repo deps
- [x] A-004 R5: spawn fetches first, pins the SHA and stops on fetch failure
- [x] A-005 R6: dependency code is handled per mode with conflict rollback
- [ ] A-006 R9: ordered merge implements the five rules and the stacked-prs step merge — Not met: a transient `--disable-auto` failure leaves a halted item marked armed, while later `step` passes skip halted heads and never retry the required disarm.
- [x] A-007 R10: merge-auto defers the next spawn until the merge is verified
- [x] A-008 R11: PR Recovery writes its marker before acting and is bounded
- [x] A-009 R14: `rk operator autopilot` verbs exist with JSON envelopes
- [x] A-010 R15: riff gains additive options with unchanged existing behavior
- [x] A-011 R17: the chat topic routes through the new verbs

### Behavioral Correctness

- [x] A-012 R5: the spawned branch carries no upstream tracking config
- [x] A-013 R16: an external state write between load and write survives; no subprocess runs under the lock

### Scenario Coverage

- [x] A-014 R6: cherry-pick conflict aborts, rolls back, opens no tab, and escalates
- [x] A-015 R9: disarm hits only the halted cone; global stop disarms everything
- [ ] A-016 R8: a dead pane is respawned once, then skipped — Not met: liveness is checked by reusable tmux pane id alone; a recycled id with a different PID is treated as the original live worker and is not respawned.

### Edge Cases & Error Handling

- [x] A-017 R2: invalid setting value, bare dependencies, duplicate ids and relative repos are rejected before any write
- [x] A-018 R13: the engine emits escalations and notes and never notifies
- [x] A-024 R3: a spawned item with an unsatisfied dependency derives as `held`, not `spawned`
- [x] A-025 R9: no PR is ever auto-merge-armed on GitHub without a durable marker `stop` can see; a failed marker write never reports success and leaves the PR disarmed
- [x] A-026 R17: the chat skill's merge-auto explanation matches the held-until-verified-merge behaviour
- [x] A-027 R18: overlapping `step` passes spawn an item at most once; a failed attach never causes a second launch
- [x] A-028 R19: only a closed list of definitive rejections clears `scope.armed`; uncertain outcomes keep it and `stop` disarms
- [x] A-029 R20: no destructive/state-advancing action is reported done unless its marker is durable
- [x] A-030 R21: no `github-pr` item is created without an explicit owner/name
- [x] A-031 R22: optional checks never block change-less completion
- [x] A-032 R23: human CLI lists are capped with exact counts and `--all`; JSON is complete
- [x] A-033 R24: a misfit without explicit `--mode` writes nothing; chat dry-runs first; exit codes match help
- [x] A-034 R25: worktree lookup reuses `internal/gitinfo`
- [x] A-035 R26: only explicit or legacy-marked queue items are spawned/respawned/listed; a bare tracked pane is never respawned
- [x] A-036 R27: a fix round is never cleaned up while required checks are pending or the head is unchanged
- [x] A-037 R28: no external mutation runs on an empty/invalid shared-state branch

### Code Quality

- [x] A-019 Pattern consistency: new code follows surrounding Go naming, error and envelope patterns
- [x] A-020 No unnecessary duplication: operator, riff, settings, fabstatus and inject utilities are reused
- [x] A-021 Every subprocess is an argv-slice `exec.CommandContext` with a timeout
- [x] A-022 Comments state constraints only and cite no change IDs

### Security

- [x] A-023 R2: repo paths and ids are validated before any exec; no shell strings

## Notes

- Rework cycle 3: T029–T032 complete. Queue membership, CI-fix lifetime, and pre-mutation branch validation are covered by `revised_rules_test.go`; the apply result lists the audited sites for R26–R28. The hermetic autopilot race suite passed (62.620s). `just test-backend` passed all packages except the explicitly excluded API load-timing test `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`; its isolated `-count=1` retry passed (3.257s). `rk/cmd/rk` passed without the host-policy exclusion. `git diff --check` passed. Acceptance remains for review.

- Rework cycle 2: T009, T011, T020, T021, and T022 are complete. `just test-backend` passed without exclusions, including the known API timing test and host-dependent port-policy test. `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1` passed. CLI usage-error tests and `git diff --check` passed. The apply result records the complete A/B/C/D audit site list; acceptance remains for review.

- Rework cycle 1: T020 and T022 are implemented and regression-tested. The final hermetic autopilot suite passed; the final backend run also passed `rk/internal/autopilot` and `rk/cmd/rk`. `just test-backend` failed twice at the unchanged API integration test `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath` (`terminals_relay_test.go:761`: isolated session reaped while a second client remained attached). T028 was unchecked in that apply result; the orchestrator subsequently verified the load-timing flake and restored it. The initial timing retry was exhausted; no API files were changed. `git diff --check` passed.

- Phase 6 validation: `just test-backend` passed with no exclusions; `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test ./internal/autopilot/ -count=1` passed; `git diff --check` passed.

- Check items as you review: `- [x]`

## Deletion Candidates

- `app/backend/internal/operator/export.go:166` — remove the newly exported `RecordPanePID` wrapper; production obtains the PID through `autopilot.Panes.PID`, and no call sites remain.

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
| 16 | Certain | A spawn claim records the pane through an additive riff window-created callback before layout/delivery; failed attach keeps that evidence, while expired unrecorded claims release without spawning in the same pass | R18 requires durable ownership and recovery before another launch; a skipped retry gives abandoned worktrees an explicit escalation | S:95 R:80 A:85 D:85 |
| 17 | Certain | Cap each human list at 20 entries, with exact totals, an explicit truncation notice and `--all`; JSON remains complete | shll principles P9 requires an explicit cap and notice but fixes no universal numeric cap | S:90 R:95 A:85 D:80 |

| 18 | Certain | Global stop persists all pause/halt intent in one locked write before disarming; a failed disarm marker remains available for retry and returns an operational error | R20 requires durable stop intent before acknowledgement and idempotent disarming covers uncertain arms | S:95 R:80 A:90 D:90 |
| 19 | Certain | Keep riff Options comparable and expose the pane-created callback through SpawnObserved; reconciliation derives an unknown branch from the recorded worktree | Existing callers compare Options by value; a generated branch must be derived rather than guessed from a worktree name | S:95 R:85 A:95 D:90 |

| 20 | Certain | The spawn claim compares the full tracked-item and branch-map snapshot used by the gate under the state lock; any concurrent ledger edit defers this spawn to a fresh pass | This conservatively preserves all readiness and dependency-code evidence without running a subprocess under the lock | S:95 R:90 A:95 D:90 |
| 21 | Confident | Git quiet-probe exit 1, pending/failing required-check results, and already-enabled or successfully completed merge outcomes remain normal control flow; disabled auto-merge, operational lookup and cleanup failures escalate with deduplicated notes | Expected negative probes and supported fallbacks must remain usable while transport, execution, and discovery failures remain visible | S:85 R:85 A:90 D:80 |
| 22 | Confident | A failed completion-summary PR lookup returns structured status escalations and an operational error without writing notes | The status read-only contract takes precedence over persisting escalation notes; both human and JSON callers receive the failure | S:85 R:90 A:90 D:80 |

| 23 | Certain | One snapshot CAS owns initial spawns, respawns, CI sends/spawns, and both rebase worktree paths; one launch helper records every pane and one attach transaction finalizes it | Concurrent passes cannot spend the same allowance; recovery panes remain owned by their PR until their pane item and parent link commit together | S:95 R:90 A:95 D:95 |
| 24 | Confident | An undelivered or uncertain CI send retains a pending claim when rollback or completion persistence fails; an expired send claim rolls back without counting a spent recovery round | A pending claim prevents duplicate sends and prevents false timeout halts for a round that was never durably delivered | S:85 R:85 A:90 D:80 |
| 25 | Certain | Worktree cleanup and pane-fingerprint/marker failures return to the engine; failed worktree cleanup retains the claim for lease-expiry reconciliation, and failed pane ownership persistence closes the new window | Every created resource has durable ownership or an explicit compensation and failure report | S:95 R:90 A:95 D:90 |
| 26 | Confident | Known already-disabled/ready/armed/merged/aborted responses converge; retarget verifies the requested base; explicit empty mode/repo flags and invalid or unmatched repo filters are usage errors | Idempotence must prove the desired end state, and a typo must not silently broaden or empty the requested operation | S:85 R:90 A:90 D:85 |

| 27 | Confident | Dependency edges identify both pane endpoints of a legacy queue chain, including an all-null-mode chain; unknown, self, and recovery-worker edges do not establish membership. An isolated unmarked null-mode pane is ordinary tracking | R26 explicitly preserves legacy dependency chains and excludes isolated null-mode items; queue membership is independent of repo validity, which is checked before execution | S:80 R:85 A:80 D:80 |
| 28 | Certain | Keep a CI fix worker until required checks are green on a changed current head; pending checks retain ownership, including on an externally merged PR. A failed new head or the no-push bound closes the round through halt | R27 requires a changed head and resolved checks; recovery markers remain as merge-report evidence and claim ownership prevents concurrent cleanup | S:95 R:90 A:95 D:95 |
| 29 | Certain | Validate supplied item/dependency/branch-map branches before spawn fetch, and both stacked branches and recovery branches before claims or mutations; worktree/ref helpers defensively reject empty branches | R28 treats shared state as input; missing branches are permitted only for a new spawn that generates its branch | S:95 R:90 A:95 D:95 |

29 assumptions (9 certain, 19 confident, 1 tentative).
