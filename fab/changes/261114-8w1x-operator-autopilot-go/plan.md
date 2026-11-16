# Plan: Operator Autopilot Core (R6a)

**Change**: 261114-8w1x-operator-autopilot-go
**Intake**: `intake.md`

> The branch already carries the full-scope R6 engine (`app/backend/internal/autopilot/`, `cmd/rk/operator_autopilot.go`). This plan **shrinks and finishes** it to the R6a scope: add the single-writer pass lock, delete the claim machinery it replaces, move the `stacked-prs` merge path and PR recovery out (R6b/R6c port them from `261114-8w1x-r6-full-reference`), fix the halted-and-armed disarm, swap the brief. Behaviour the intake marks "keep" is already built; its requirements are restated so review can hold the code to them.

## Requirements

### Concurrency: single writer

#### R1: Per-server pass lock
`autopilot.Step`, `autopilot.StartMerge` and `autopilot.Stop` (and their CLI verbs) SHALL take an exclusive, non-blocking `flock` (`LOCK_EX|LOCK_NB`) on `<state dir>/<slug>.autopilot.lock` — the directory and `cron.FabOperatorSlug` slug of the server's operator state file — for the whole pass, released on return (the OS releases it on process death). When the lock is held, the call SHALL do nothing and return a result with `Busy: true`; the CLI exits 0 and prints `busy` (human: one line saying another autopilot pass is running on this server, retry later; `--json`: `{"ok":true,"result":{"busy":true,…}}`). `queue`, `status` and `step --dry-run` SHALL NOT take the pass lock. The state file's sidecar lock is unchanged.

- **GIVEN** a process holds the pass lock **WHEN** `step`, `merge` or `stop` runs for the same server **THEN** it returns `busy`, makes no state write and runs no git/gh/wt/fab/tmux mutation, and the CLI exits 0
- **GIVEN** a pass returned (normally or with an error) **WHEN** the next pass runs **THEN** it acquires the lock
- **GIVEN** the lock is held for server A **WHEN** `step` runs for server B **THEN** B is not busy

#### R2: Claim machinery removed
The concurrency machinery the pass lock replaces SHALL be deleted: `internal/autopilot/claim.go` (`claimSpawn`, `claimWork`, `claimToken`/`claimOf`, `rollbackClaim`, `rollbackUnopened`, `finishWorkClaim`, `launchClaimed`, `releaseClaim`, `recordClaimPane`, `reconcileClaim`, claim leases), the snapshot compare-and-set, `claim_test.go`, and every overlapping-pass test. Launch paths become straight-line code with no claim token.

- **GIVEN** the finished branch **WHEN** searched for `claimToken`, `claimWork`, `reconcileClaim` or `scope.claim` **THEN** nothing is found in non-reference code

#### R3: `spawning` intent marker
Before any launch (spawn or respawn) the engine SHALL write `scope.spawning` (RFC 3339 timestamp) on the item in one locked write; right after the launch it SHALL write `scope.pane`, `session`, `branch` and `branch_map[<change-or-id>]` and clear `spawning` in one locked write merged by item id. A pass that finds `spawning` set and no `scope.pane` SHALL NOT launch for that item; it escalates once per pass `spawn interrupted: <id> — check for an orphaned window, then clear scope.spawning with rk operator track update` and leaves the item alone. A launch that fails before a window exists (fetch failure, gate failure, cherry-pick conflict with worktree rolled back) clears `spawning` again. If the post-launch attach write fails, the pass escalates naming the pane and leaves `spawning` set.

- **GIVEN** an item with `scope.spawning` set and no pane **WHEN** `step` runs **THEN** no `wt create`/tab open is issued and an escalation is emitted
- **GIVEN** a fetch failure during spawn **WHEN** the pass ends **THEN** `spawning` is cleared and the item is `pending`
- **GIVEN** a successful spawn **WHEN** the pass ends **THEN** the item has `pane`, `session`, `branch` and no `spawning`

#### R4: State lock discipline
The store's sidecar lock SHALL never be held across a subprocess; every write SHALL load fresh state under the lock, merge by item id, and keep external writes to other items/keys (Constitution II, external writes win).

- **GIVEN** an external writer adds a tracked item between the engine's load and write **WHEN** the engine writes **THEN** the external item survives

### Autopilot: queue

#### R5: Queue verb
`autopilot.Enqueue` SHALL persist N pending `pane` items in one locked write: stamp `scope.queue` (queue id) and `scope.merge_mode` (resolved `--mode` > `operator.merge_mode` > `cherry-pick-ladder`, source printed `flag|setting|default`; invalid setting → error naming the valid set) on every item; apply implicit chaining (nearest earlier same-repo entry, else the previous entry; explicit `depends_on` replaces it; `merge-auto`: previous entry as ordering barrier only); reject before writing forward/cyclic deps, deps on bare entries, duplicate or already-tracked ids, non-absolute/non-git-root repos and invalid branches. A live call whose receipt carries a misfit (`merge-auto` with explicit same-repo `depends_on`) and no explicit `--mode` SHALL write nothing and error naming the misfit. `--dry-run` writes nothing and returns the receipt.

- **GIVEN** entries ab12(foo), cd34(bar), ef56(foo) **WHEN** queued **THEN** `cd34.depends_on=[ab12]` and `ef56.depends_on=[ab12]`
- **GIVEN** an entry depending on a bare entry, or a forward/cyclic dep **WHEN** queued **THEN** the call is rejected and nothing is written
- **GIVEN** a merge-auto queue with explicit same-repo deps and no `--mode` **WHEN** queued live **THEN** nothing is written

#### R6: Explicit queue membership
An item SHALL be queue work iff it carries `scope.queue`, or (legacy) a non-null `scope.merge_mode`, or it has a `depends_on` edge with another queue-eligible item. Other tracked panes (e.g. a bare pane from `rk operator track add`) SHALL never be spawned, respawned or listed by `status`.

- **GIVEN** a bare pane tracked with `rk operator track add` **WHEN** its pane dies **THEN** autopilot never respawns it

### Autopilot: readiness gate

#### R7: Derived state and dependency satisfaction
Derived state SHALL follow `done` › `paused` › `held` › `pending` › `spawned` (a held item stays held even with a pane); stored null mode reads `cherry-pick-ladder`. A dependency is satisfied when done: fab item via `done_at` / `ship` done or skipped / `stop_stage` reached; change-less item when its branch has an open PR whose **required** checks pass (`gh pr checks <n> --required`; none required = pass; optional checks ignored) or a merged PR, persisted as `done_at`. A same-repo dep with null `stop_stage` additionally needs an existing PR. A dep only in `branch_map` passes; an unknown dep id does not.

- **GIVEN** a same-repo dep that is done but has no PR **WHEN** the dependent is evaluated **THEN** it stays held
- **GIVEN** an optional check fails and required checks pass on a change-less item's PR **WHEN** evaluated **THEN** the item is done

#### R8: Shared-state branch validation
Every branch read from shared state (item scope, `branch_map`) SHALL be validated with `safeBranch` before any fetch, worktree, push or gh call on that path; an empty/invalid branch escalates with no mutation.

- **GIVEN** a malformed dep `scope.branch` **WHEN** the dependent spawns **THEN** nothing is fetched or created and an escalation is emitted

### Autopilot: spawn

#### R9: Fetch-first SHA pin and confidence gate
Spawn SHALL target `scope.repo`, run `git fetch origin` first (failure = hard stop: no `wt create`, item stays pending, escalation, `rev-parse` never consulted), resolve the default branch via verified `origin/HEAD` → `gh repo view` → `main`/`master` probe, and base the worktree on the **SHA** of `origin/<default>` (no upstream tracking). An existing fab change whose `.status.yaml` confidence score is below 3.0 SHALL NOT be spawned (escalation); raw-text entries skip the gate.

- **GIVEN** local HEAD lags `origin/<default>` **WHEN** an item spawns **THEN** its branch starts at the fetched tip SHA and has no `branch.<b>.remote`

#### R10: Dependency code by mode
For the same-repo dep subset (cross-repo deps are gate-only): **`cherry-pick-ladder`** resolves each dep branch (`scope.branch`, else `branch_map`; missing → escalate, no spawn), prunes deps that are ancestors of another dep's branch, skips deps already ancestors of `HEAD`, runs `git cherry-pick --no-commit origin/<default>..<dep-branch>` + `git commit -m "operator: cherry-pick <dep> dependency"`, and on conflict aborts, rolls the worktree back, escalates and opens no tab; **`stacked-prs`** cuts the new branch from the SHA of `origin/<dep-branch>` (never `--checkout`) and records the base (`fab status set-base-branch <change> <dep-branch>` for an existing change; trailing prompt instruction for raw-text fab entries; dep branch as PR base for plain agents); **`merge-auto`** bases on `origin/<default>` independently.

- **GIVEN** a cherry-pick conflict **WHEN** spawning **THEN** the cherry-pick is aborted, the worktree removed, no tab opened and an escalation emitted
- **GIVEN** a stacked-prs dependent of an existing change **WHEN** spawned **THEN** its base is the dep's tip SHA and `set-base-branch` ran

#### R11: Prompt, session, attach
The prompt SHALL follow the two-axis table (fab present × task given: `<prefix>fab-fff <change>` / `<prefix>fab-new <text>` / task + "Commit on this branch, push, and open a draft PR against <base>." / no token for bare), using the **target** repo's `fab agent default` command and prefix; never `fab init`. The tab opens through `internal/riff` in-process in the role-aware landing session with the `auto` mark and `"<id> · <stage>"` note; pointer activation (`fab change switch`) is fail-soft.

- **GIVEN** a non-fab repo with a task **WHEN** spawned **THEN** the prompt is the task plus the draft-PR instruction naming the base

#### R12: One respawn
A spawned queue item whose pane is gone and that is not done SHALL get exactly one existing-branch respawn, `scope.respawned: true` written before acting (together with `spawning`); afterwards it is skipped with an escalation and dependents stay held. Liveness keyed by tmux pane id is accepted.

- **GIVEN** a respawned item whose pane died again **WHEN** `step` runs **THEN** nothing launches and an escalation is emitted

### Autopilot: merge

#### R13: Merge verb
`StartMerge` SHALL create per-repo `github-pr` chains (`scope {repo, pr, change, merge_seq}`, `depends_on` the previous PR, base-first, cross-repo barriers preserved) for completed `cherry-pick-ladder` queues and arm/merge the first PR per sequence. It SHALL refuse while queue items are not done, be a no-op for `merge-auto` items, and **refuse a `stacked-prs` sequence** with an error pointing at the run brief's stacked-prs merge text (no items written, no gh mutation). A `github-pr` item SHALL always carry an explicit `owner/name`; when unresolvable, no item is created and an escalation is emitted.

- **GIVEN** a completed stacked-prs queue **WHEN** `merge` runs **THEN** it errors with the pointer and writes nothing
- **GIVEN** `gh repo view` fails **WHEN** a PR item would be created **THEN** none is created and an escalation is emitted

#### R14: Auto-Merge rules (`cherry-pick-ladder`)
`step` SHALL advance sequences per the five rules: (1) at most one armed PR per repo sequence, PR_n armed only after PR_{n-1}'s merge is verified; (2) ready a draft first, always `--squash`, "already clean" → direct `gh pr merge --squash`, auto-merge disabled → step-driven direct merge when required checks are green and `MERGEABLE`; (3) stall: a failed required check, or `unchanged ≥ 3` with no failed check and `CONFLICTING`, emits `recovery needed: <ci-failed|conflicting> — PR #<n> (<repo>)` once per head SHA/reason and takes **no** action — the PR stays armed; (4) the items are the sequence; (5) a halt disarms only the halted cone (failing repo's sub-sequence plus repos with a transitive cross-repo `depends_on` into it).

- **GIVEN** an armed PR with a failed required check **WHEN** `step` runs **THEN** it escalates `recovery needed: ci-failed`, sends no fix request, and does not disarm
- **GIVEN** two independent repo sequences and a halt in one **WHEN** `step` runs **THEN** the other keeps advancing

#### R15: Arm outcome durability
`scope.armed` SHALL be written before `gh pr merge --auto --squash`. Only a definitive rejection from a closed, tested list (auto-merge not allowed on the repo, PR not armable, "clean status" → direct merge) clears it; timeouts, network/5xx and unrecognised errors keep it and escalate `arm outcome uncertain`.

- **GIVEN** `gh pr merge --auto` times out **WHEN** the pass ends **THEN** `armed` is still set

#### R16: Durable disarm retry
A PR item with `halted` set (cone halt, or `stop`) and `armed` still set SHALL be retried with `gh pr merge --disable-auto` on every later `step` and `stop` pass until the disarm succeeds or reports already-disabled, or the PR is merged/closed; only then is `armed` cleared. Each failed attempt escalates. A halted head is never re-armed or merged by the engine.

- **GIVEN** a halted PR whose disarm failed transiently **WHEN** the next `step` runs **THEN** `--disable-auto` is issued again and, on success, `armed` is cleared
- **GIVEN** a stop whose disarm failed **WHEN** `stop` runs again **THEN** the disarm is retried

#### R17: Persist before acknowledge
Markers that acknowledge an action (`halted`, merged completion `done_at`, stop's pause/halt, cleared `armed`) SHALL be written before the action is reported; where the external action must come first and the write fails, the result carries an escalation and no success action.

- **GIVEN** the state write fails after a verified merge **WHEN** the pass reports **THEN** it reports an escalation, not `merged`

#### R18: merge-auto
When a `merge-auto` item ships, `step` SHALL create its one-PR `github-pr` sequence and arm it per R14 rule 2. The next queue item stays `held` until that merge is verified, then spawns on the advanced tip via R9. A halt disarms that PR (R16) and escalates; the next spawn stays deferred.

- **GIVEN** a merge-auto queue whose first PR is armed but not merged **WHEN** `step` runs **THEN** the second item is not spawned

#### R19: Merge reporting
Merge actions SHALL carry repo and position (`ab12: merged (foo 1/2)`); a PR merged with no non-`PENDING` review is marked `· unreviewed` and summarised once per pass as `merged without review: #n (<change>), …`.

- **GIVEN** a merge with no reviews **WHEN** reported **THEN** the summary line names it

### Autopilot: stop, status, escalations

#### R20: Stop and status
`Stop` SHALL halt unfinished PR items, disarm every armed PR (R16), and pause every unspawned queue item; live panes are untouched. `Status` SHALL be read-only (no pass lock, no escalations) and list per queue item derived state, mode, repo, branch, PR and merge position, plus the Queue Completion Summary when all items are done.

- **GIVEN** a queue with one unspawned item and one armed PR **WHEN** `stop` runs **THEN** the item is paused and the PR disarmed

#### R21: Escalations only
The engine SHALL never notify; failures and halts are structured escalations in the result plus a note on the item.

- **GIVEN** any escalation **WHEN** the pass runs **THEN** no `rk notify` / notify call is made by the engine

### Scope: moved out

#### R22: stacked-prs merge path and PR recovery removed
The `stacked-prs` merge path (`stackedStep`, `prepareStacked`, base retarget `retarget` in `idempotent.go`, `rebase --onto` + `--force-with-lease`, `scope.prepared`) and all of `recovery.go` (`ci-failed` fix round, `conflicting` rebase + re-arm, recovery spawn, authoring-pane lookup, `scope.recovery`/`fix_head`/`fix_item`/`fix_for`, `<change>-fix` items) SHALL be removed with their tests; helpers left with no caller are deleted. Tests covering R6a behaviour in shared test files stay, adapted.

- **GIVEN** the finished branch **WHEN** `internal/autopilot` is searched for `prepareStacked`, `rebase --onto`, `--force-with-lease`, `recovery.go`, `fix_head` **THEN** nothing is found

#### R23: `RecordPanePID` deleted
`operator.RecordPanePID` (no callers) and any `scope.pane_pid` code that exists only for it SHALL be deleted.

- **GIVEN** the finished branch **WHEN** searched for `RecordPanePID` **THEN** nothing is found

### CLI

#### R24: `rk operator autopilot`
`queue|step|merge|stop|status` SHALL exist under `rk operator` with `-L/--server` (default: the caller's server from `$TMUX`) and `--json` envelope; `step --dry-run` reports a plan with no side effects; human output of every list caps per the shll P9 list-cap standard with exact totals, a truncation notice and `--all` (JSON stays complete); exit codes 0 ok (including `busy`), 1 operational, 2 usage/invalid, and the help text states exactly what the implementation does (pinned by CLI tests); help conforms to the shll toolkit standards.

- **GIVEN** the pass lock is held **WHEN** `rk operator autopilot step --json` runs **THEN** it exits 0 with `"busy":true`
- **GIVEN** more items than the cap **WHEN** `status` prints for a human **THEN** it shows the cap, the exact total and the `--all` hint

### Run brief and chat skill

#### R25: Brief swap
`internal/operator/brief_autopilot.md` SHALL replace "Items and readiness", "Spawning a queue item", the `cherry-pick-ladder` and `merge-auto` parts of "Merging", and the non-recovery rows of "Failures and timing" with the instruction to run `rk operator autopilot step -L <server>` and act on its escalations (send `rk notify` for each; never run the spawn/arm choreography by hand). The `stacked-prs` merge-all text stays (noting `rk operator autopilot merge` refuses it), "PR recovery" stays in full (noting `step` reports these cases as `recovery needed: <reason>` escalations), and the recovery rows of "Failures and timing" stay. The header line no longer claims the whole file is replaced by the engine. A test renders `operator.RenderBrief` and asserts the replaced sections are gone, the `step` instruction is present, and the stacked-prs merge and PR recovery text remain.

- **GIVEN** a rendered brief **WHEN** inspected **THEN** it contains `rk operator autopilot step` and no `### Items and readiness` / `### Spawning a queue item` sections

#### R26: Chat skill consistency
`cmd/rk/skill/operator.md` and its mirror `docs/site/skill/operator.md` SHALL state that "merge all" on a `stacked-prs` queue follows the run brief's stacked-prs text because `rk operator autopilot merge` refuses it, and that `step` reports CI failures and conflicts as `recovery needed` escalations; the two files stay in sync.

- **GIVEN** the chat skill topic **WHEN** read **THEN** it does not claim `merge` handles stacked-prs queues

### Settings

#### R27: `operator.merge_mode` unchanged
The settings key `operator.merge_mode` SHALL stay as built (enum of the three modes, absent → `cherry-pick-ladder`, invalid write rejected, read only at `queue`); rk never reads fab's `autopilot.merge_mode`.

- **GIVEN** `operator.merge_mode: stacked-prs` **WHEN** `queue` runs without `--mode` **THEN** items are stamped `stacked-prs` with source `setting`

### Non-Goals

**Review bar (binding — quoted in every review dispatch):**

> **Must-fix**: anything that can merge, arm, push, force-push or delete the wrong thing; lose or corrupt state-file data; launch a duplicate agent *under the single-writer rule*; crash the CLI; or break a requirement in the step's plan. **Should-fix** (does not block): failure cases the pass lock rules out, tmux pane-id reuse, missing escalations for read-only probes, and cosmetics.

- Failure cases the pass lock rules out (overlapping `step`/`merge`/`stop` passes) — should-fix at most
- tmux pane-id reuse — accepted; should-fix at most
- Missing escalations for read-only probes; cosmetics — should-fix
- `stacked-prs` merge-all — R6b
- PR recovery actions — R6c
- Deleting `brief_autopilot.md` and the reference branch — R7
- Daemon-driven `step` — candidate R8
- MCP tools for the verbs
- Reading fab's `autopilot.merge_mode`

### Design Decisions

#### Single-writer pass lock instead of claims
**Decision**: Serialise `step`/`merge`/`stop` per server with a non-blocking `flock` on `<slug>.autopilot.lock`; a second caller returns `busy` (exit 0). Crash safety rests on the `spawning` intent marker, which never auto-relaunches.
**Why**: Removes the overlapping-pass failure class wholesale; R6's claim/CAS machinery kept generating new findings. `flock` is released by the OS on process death, so the lock cannot leak (Constitution II).
**Rejected**: Durable claims with leases and CAS snapshots — correct but unbounded review surface; a blocking lock — a stuck pass would hang runs and chat.
*Introduced by*: 261114-8w1x-operator-autopilot-go

#### Stall is an escalation until R6c
**Decision**: A failed required check or a `CONFLICTING` stall yields `recovery needed: <reason>` and leaves the PR armed.
**Why**: PR recovery moves to R6c; the run follows the brief's recovery text meanwhile.
**Rejected**: Disarming on stall — would turn a recoverable PR into a halted one before recovery exists.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### Deprecated Requirements

#### Durable spawn claim (R6 R18)
**Reason**: Replaced by the single-writer pass lock.
**Migration**: R1 + R3 (`spawning` marker).

#### PR Recovery and CI-fix round lifecycle (R6 R11, R27)
**Reason**: Moved to R6c.
**Migration**: R14 rule 3 escalation; R6c ports from the reference branch.

#### stacked-prs merge-all (part of R6 R9)
**Reason**: Moved to R6b.
**Migration**: R13 refusal; R6b ports from the reference branch.

## Tasks

### Phase 1: Setup

- [x] T001 Add the pass lock: a helper in `app/backend/internal/autopilot/` (e.g. `passlock.go`) that derives `<state dir>/<slug>.autopilot.lock` from the same resolution as `operator.StatePath*` / `cron.FabOperatorSlug`, takes `syscall.Flock(LOCK_EX|LOCK_NB)`, and returns a release func or a busy sentinel; add `Busy bool` to `StepResult` (JSON `busy`). Unit tests: held → busy, released → acquirable, per-server isolation <!-- R1 -->
- [x] T002 Wire the pass lock into `Step`, `StartMerge` and `Stop` (not `Enqueue`, `Status`, or `Step` under `DryRun`): on busy return immediately with `Busy: true` and no side effects <!-- R1 -->

### Phase 2: Core Implementation

- [x] T003 Delete `internal/autopilot/claim.go` and `claim_test.go`; rewrite `spawnPending`, `spawnItem`, `attach`, `respawnDead`/`respawn`, `worktreeFor` and `advance`/`advanceSeq`/`haltCone` in `spawn.go`/`merge.go` without claim tokens, snapshot CAS or claim reconciliation <!-- R2 -->
- [x] T004 Implement the `spawning` marker in `spawn.go`: write before launch (with `respawned: true` for a respawn), attach clears it with `pane`/`session`/`branch`/`branch_map` in one merged write, pre-window failures clear it, a `spawning`-without-pane item escalates and is skipped; attach-write failure escalates naming the pane <!-- R3 -->
- [x] T005 Remove the `stacked-prs` merge path from `merge.go`/`idempotent.go` (`stackedStep`, `prepareStacked`, `retarget`, rebase/force-push code, `scope.prepared`) and make `StartMerge` refuse a `stacked-prs` sequence with an error pointing at the run brief, writing nothing <!-- R13, R22 -->
- [x] T006 Delete `recovery.go` and every recovery reference in `merge.go`/`step.go`/`spawn.go` (`scopeRecovery`, `fix_head`, `fix_item`, `fix_for`, `<change>-fix` handling, authoring-pane lookup, `progressFixRound`); replace the stall branch of `driveHead` with the `recovery needed: <reason> — PR #<n> (<repo>)` escalation (once per head SHA + reason), PR left armed, no action <!-- R14, R22 -->
- [x] T007 Durable disarm retry in `merge.go`/`step.go`: during `advance`, for every PR item with `halted` and `armed`, retry `disarm` (success, already-disabled, or PR merged/closed → clear `armed`; failure → escalate, keep `armed`); `Stop` does the same for already-halted armed items; a halted head is never re-armed or merged <!-- R16, R20 -->
- [x] T008 Verify arm durability and persist-before-acknowledge after the rewrite: `armed` written before `gh pr merge --auto`, closed definitive-rejection list in `definitiveArmRejection`, uncertain outcomes keep the marker; merged/halted/stop markers written before their action lines; fix any path the claim removal broke <!-- R15, R17 -->
- [x] T009 Delete `operator.RecordPanePID` and any `pane_pid`-only code in `internal/operator/export.go` and callers/tests <!-- R23 -->
- [x] T010 Delete helpers left without callers after T003–T009 (`go vet` + `staticcheck`-style unused check by `go build` / grep) across `internal/autopilot/` <!-- R22 -->

### Phase 3: Integration & Edge Cases

- [x] T011 CLI `cmd/rk/operator_autopilot.go`: print `busy` for `step`/`merge`/`stop` (human one-liner, JSON `busy:true`, exit 0); `merge`'s stacked-prs refusal maps to exit 1 with the pointer message; update help text (busy, exit codes, merge's stacked-prs refusal, `recovery needed` escalations) so it matches the implementation <!-- R1, R13, R24 -->
- [x] T012 Brief swap in `app/backend/internal/operator/brief_autopilot.md` per R25 (keep stacked-prs merge text and "PR recovery", keep recovery rows of "Failures and timing", new header line) and update `internal/operator/brief_test.go` (budget, section assertions) <!-- R25 -->
- [x] T013 [P] Chat-skill text in `app/backend/cmd/rk/skill/operator.md` and `docs/site/skill/operator.md`: stacked-prs "merge all" follows the brief; `step` escalates `recovery needed`; mention `busy` → retry; keep the two in sync <!-- R26 -->

### Phase 4: Tests

- [x] T014 Remove overlapping-pass, claim, stacked-merge and recovery tests from `lifecycle_test.go`, `merge_test.go`, `escalation_test.go`, `revised_rules_test.go`, `durability_test.go`; adapt the surviving R6a tests (and `harness_test.go`) to the claim-free engine <!-- R2, R22 -->
- [x] T015 Add engine tests: pass lock busy for `Step`/`StartMerge`/`Stop` with no runner calls; `spawning` without pane escalates and never launches; fetch failure clears `spawning`; respawn writes `respawned` + `spawning` first and a second death escalates <!-- R1, R3, R12 -->
- [x] T016 Add merge tests: `StartMerge` refuses stacked-prs and writes nothing; failed required check → `recovery needed: ci-failed`, PR still armed, no gh mutation; `unchanged ≥ 3` + `CONFLICTING` → `recovery needed: conflicting`; halted+armed disarm failure retried on next `step` and cleared on success; `stop` retries a failed disarm; uncertain arm keeps `armed`; merge-auto defers the next spawn until verified merge <!-- R13, R14, R15, R16, R18, R20 -->
- [x] T017 [P] CLI tests in `cmd/rk/operator_autopilot_test.go`: `busy` exit 0 human + JSON; `merge` stacked-prs refusal exit 1; help text states the exit codes and busy behaviour; bounded lists with `--all` <!-- R24 -->
- [x] T018 Confirm the kept-behaviour tests still cover R4–R11, R19, R21, R27 (queue chaining/validation/misfit, membership, readiness incl. required-checks-only, branch validation, fetch-first SHA pin, upstream tracking, default-branch chain, ancestor pruning, cherry-pick conflict rollback, stacked-prs spawn base + `set-base-branch`, two-axis prompts, external-write survival, unreviewed reporting, mode ladder); add any missing case <!-- R4, R5, R6, R7, R8, R9, R10, R11, R19, R21, R27 -->
- [x] T019 Run the gates from `app/backend`: `just test-backend` (repo root) and `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`, plus `go vet ./...`; only `TestPortPinRowRealPolicyValues` and `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath` may fail (known host-only) <!-- R1 -->

## Execution Order

- T001 → T002 → T003 → T004 (claim removal and the marker touch the same spawn code)
- T005, T006 after T003; T007 after T006 (same `advance` path); T008, T010 after T005–T007
- T014 after T003–T010; T015–T018 after T014; T019 last

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `Step`, `StartMerge` and `Stop` take a non-blocking per-server `flock` on `<slug>.autopilot.lock` and return `Busy` with no side effects when it is held; `queue`, `status` and dry-run do not take it
- [ ] A-002 R2: `claim.go`, claim tokens, snapshot CAS and overlapping-pass tests are gone
- [ ] A-003 R3: `scope.spawning` is written before every launch and cleared by the attach write; `spawning` without a pane never relaunches and escalates
- [ ] A-004 R4: state writes merge by id under the sidecar lock, never held across a subprocess
- [ ] A-005 R5: `queue` stamps `scope.queue` and the resolved mode, chains implicitly, validates before writing, and refuses a live misfit without `--mode`
- [ ] A-006 R6: only explicit queue members are spawned/respawned/listed
- [ ] A-007 R7: readiness follows the derived-state precedence and required-checks-only completion
- [ ] A-008 R8: shared-state branches are validated before mutation
- [ ] A-009 R9: spawn fetches first, stops on fetch failure, pins the SHA, applies the confidence gate
- [ ] A-010 R10: dependency code per mode matches the intake for all three modes
- [ ] A-011 R11: prompts follow the two-axis table using the target repo's agent resolution
- [ ] A-012 R12: exactly one respawn, recorded before acting
- [ ] A-013 R13: `merge` creates per-repo chains with explicit `owner/name`, refuses incomplete queues and stacked-prs sequences
- [ ] A-014 R14: the five Auto-Merge rules hold; stalls only escalate `recovery needed` and leave the PR armed
- [ ] A-015 R15: `armed` is written before arming and kept on uncertain outcomes
- [ ] A-016 R16: halted-and-armed PRs are re-disarmed on every later `step`/`stop` until durable
- [ ] A-017 R17: acknowledging markers are persisted before the action is reported
- [ ] A-018 R18: merge-auto arms on ship and defers the next spawn until the merge is verified
- [ ] A-019 R19: merge lines carry repo/position and unreviewed merges are summarised
- [ ] A-020 R20: `stop` halts, disarms and pauses; `status` is read-only with the completion summary
- [ ] A-021 R21: the engine never notifies
- [ ] A-022 R24: CLI verbs, `busy` exit 0, bounded lists with `--all`, exit codes and help match the implementation
- [ ] A-023 R25: the brief's covered sections are replaced by the `step` instruction and a render test proves it
- [ ] A-024 R26: chat-skill text and its docs/site mirror are consistent with `merge`'s stacked-prs refusal
- [ ] A-025 R27: `operator.merge_mode` behaves as built

### Removal Verification

- [ ] A-026 R22: no `stacked-prs` merge path (`prepareStacked`, retarget, rebase `--onto`, force-push) or PR recovery code (`recovery.go`, `fix_head`, `<change>-fix`) remains in `internal/autopilot`, and no helper is left without a caller
- [ ] A-027 R23: `RecordPanePID` is gone

### Scenario Coverage

- [ ] A-028 R1: a test holds the lock and proves `step`/`merge`/`stop` return busy with zero runner calls, and a CLI test proves exit 0
- [ ] A-029 R16: a test fails a halt's disarm, runs `step` again, and sees `--disable-auto` reissued and `armed` cleared on success
- [ ] A-030 R14: tests prove failed-check and conflicting stalls escalate `recovery needed` with no gh mutation
- [ ] A-031 R25: the brief render test asserts replaced sections gone, `step` instruction present, stacked-prs merge and PR recovery text present

### Edge Cases & Error Handling

- [ ] A-032 R3: fetch failure, confidence-gate refusal and cherry-pick conflict all clear `spawning` and leave the item pending
- [ ] A-033 R13: `merge` with no resolvable `owner/name` creates no item and escalates
- [ ] A-034 R15: a `gh pr merge --auto` timeout leaves `armed` set and escalates `arm outcome uncertain`

### Code Quality

- [ ] A-035 Pattern consistency: new code follows the package's existing naming, `Runner` seam and error/escalation patterns
- [ ] A-036 No unnecessary duplication: existing utilities (`internal/gitinfo`, `internal/riff`, `operator` store helpers, `safeBranch`) are reused
- [ ] A-037: every exec uses `exec.CommandContext` with argv slices and a timeout; no shell strings
- [ ] A-038: no god functions added (>50 lines without clear reason); constants named, no magic strings for scope keys
- [ ] A-039: comments state constraints only — no narration, no change IDs or PR numbers
- [ ] A-040: tests cover added/changed behaviour; `main_test.go` keeps the hermetic git environment

### Security

- [ ] A-041 R8: no branch or repo from shared state reaches git/gh/wt without validation

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- Review bar: see `### Non-Goals`. Findings in the should-fix classes do not fail review.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The pass lock file lives beside the state file as `<slug>.autopilot.lock` using the same slug/dir resolution | Restructure plan binding decision names the path | S:95 R:85 A:90 D:90 |
| 2 | Confident | `recovery needed` escalates once per head SHA + reason (dedup via an item note), not every pass | Avoids notify spam each run; matches `flagOnce` pattern in `step.go` | S:70 R:85 A:75 D:70 |
| 3 | Confident | A failed attach write after launch leaves `spawning` set (so no relaunch) and escalates with the pane id | Intake: "spawning without a pane escalates and never relaunches"; leaving it set is the safe direction | S:80 R:80 A:80 D:70 |
| 4 | Confident | `merge`'s stacked-prs refusal is an operational error (exit 1), not usage (exit 2) | The arguments are valid; the state (mode) is what refuses | S:65 R:90 A:75 D:65 |
| 5 | Confident | Disarm retry treats "PR merged/closed" as terminal and clears `armed` | A merged/closed PR cannot auto-merge again; retrying forever would spam | S:75 R:85 A:85 D:80 |

5 assumptions (1 certain, 4 confident, 0 tentative).
