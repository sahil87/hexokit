# Plan: Autopilot PR recovery (R6c)

**Change**: 261116-m8io-autopilot-pr-recovery
**Intake**: `intake.md`

## Requirements

All paths are under `app/backend/` unless stated. Design authority: `intake.md` (§ What Changes,
§ Non-goals) and `fab/plans/sahil/26-11-16-operator-autopilot-restructure.md` (§ Engine model,
§ Rule table, § R6c brief, § Rules 6–7). The reference engine is read **only** with
`git show "origin/261114-8w1x-r6-full-reference:<path>"` (fetch first); never merged or
cherry-picked.

### Engine state: recovery keys and fix items

#### R1: PR recovery keys
PR engine items SHALL carry the optional fields `recovery` (a set of spent round kinds, values
`ci-fix` and `rebase`, never a single overwritten value), `fix_head` (the head SHA observed when
the `ci-fix` round was spent), `recovery_at` (RFC 3339 time the `ci-fix` round was spent) and
`fix_item` (the fix item id of a recovery spawn). They are written only by executors under the
pass lock, read tolerantly, and round-trip through `engineItemFromTracked` / `tracked()` /
`applyEngineItem` without loss. No such key is ever written onto a ledger item (rule 7).

- **GIVEN** a PR item that spent its `ci-fix` round
- **WHEN** a later pass spends its `rebase` round
- **THEN** `recovery` holds both `ci-fix` and `rebase` and `fix_head`/`recovery_at` are unchanged
- **AND** the ledger projection item carries none of the four keys

#### R2: Fix items
The engine file SHALL hold recovery-spawn agents in a new top-level `fixes:` list (same
`engineItem` shape, identity and binding fields only). A fix item's parent is the PR item whose
`fix_item` names it (reverse lookup; no back-link key). Fix items SHALL NOT participate in queue
derivation, readiness, `depends_on`, `oldestUnfinished` or merge sequences. `OwnedIDs` SHALL
include them. A fix item's ledger projection is a `pane` item with binding and identity only.

- **GIVEN** an engine file with one fix item
- **WHEN** `OwnedIDs` is called
- **THEN** the fix item id is in the result
- **AND** no queue status is derived for it

### Derived status

#### R3: PR status `fixing`
`derivePR` SHALL return `fixing` when `ci-fix` ∈ `recovery` and the observed `headRefOid` is
non-empty and equals `fix_head`. Precedence: `merged › paused › halted › closed › deferred ›
blocked › draft › fixing › failed › conflicting › green › waiting` (R6b may insert `stale-base`
before `draft`). `fixing` needs the PR view only, not the checks. A spent `ci-fix` round on a new
head falls through to the ordinary statuses.

- **GIVEN** a PR with `recovery: [ci-fix]`, `fix_head: A`, observed head `A`, checks green
- **WHEN** status is derived
- **THEN** it is `fixing`
- **AND** with observed head `B` and a failed check it is `failed`; with `B` and green it is `green`
- **AND** with state `MERGED` it is `merged`

#### R4: Fix-item statuses
A new item kind `fix` SHALL derive, first match: `resolved` (parent PR item missing, or parent
derived `merged` or `halted`, or parent head ≠ `fix_head` and parent derived `green`);
`spawn-unknown` (`spawning` set and no live pane); `working` (anything else).

- **GIVEN** a fix item whose parent PR has merged
- **WHEN** status is derived
- **THEN** it is `resolved`

#### R5: Authoring pane fact
`decide` SHALL find a PR's authoring pane purely from the pane snapshot in `facts`: the
lexicographically lowest pane id whose `PaneInfo.Change` matches the PR item's `change`
(`changeMatches`: equal, or the item's change as a `-`-delimited segment of the derived folder);
when the PR item has no `change`, the pane of its queue item (`item`) if alive. The pane is
**idle** when `AgentState` is neither `active` nor `waiting`. When `facts.panesKnown` is false no
authoring pane is considered known.

- **GIVEN** panes `%3` and `%7` both deriving change `261116-ab12-x` and a PR item with change `ab12`
- **WHEN** the authoring pane is looked up
- **THEN** it is `%3`

### Rule table

#### R6: Recovery rows replace P5
The rule table SHALL add, and `decide` SHALL fire, these rows (exact guards per intake § 3);
row P5, `stallText`, `stallGuard` and their wait reasons SHALL be removed:

| Row | Item · status | Guard | Action |
|---|---|---|---|
| C1 | PR · `fixing` | `now − recovery_at > 30 min` (`recoveryWindow`) | `halt` |
| C2 | PR · `failed` | `ci-fix` unspent, authoring pane known, alive and idle | `fix-request` |
| C3 | PR · `failed` | `ci-fix` unspent, pane snapshot known, no authoring pane | `recovery-spawn` |
| C4 | PR · `failed` | `ci-fix` spent | `halt` |
| C5 | PR · `conflicting` | `rebase` unspent, not `stacked-prs` | `rebase` |
| C6 | PR · `conflicting` | `rebase` spent, not `stacked-prs` | `halt` |
| F1 | fix · `resolved` | — | `untrack` |
| F2 | fix · `spawn-unknown` | not yet escalated | `escalate` once |

New `ActionKind`s `fix-request`, `recovery-spawn`, `rebase`, `untrack`. Halting rows carry their
reason in `Decision.Reason`: C1 `no new push 30m0s after the CI fix request — PR #<n>`, C4 `CI
still failing on check <name> after the fix round (new head <short>) — PR #<n>`, C6 `PR #<n> is
CONFLICTING again after the rebase recovery`. C1–C4 apply in every merge mode; C5–C6 do not
apply to `stacked-prs`.

- **GIVEN** a `cherry-pick-ladder` PR `failed` with `ci-fix` unspent and an idle authoring pane
- **WHEN** `decide` runs
- **THEN** row C2 fires with action `fix-request`

#### R7: Declared waits
`waitTable` SHALL declare: PR `fixing` (round in progress), PR `failed` (authoring agent busy, or
pane snapshot unknown), PR `conflicting` (`stacked-prs`: rebase is R6b's restack), fix `working`,
fix `spawn-unknown` (already escalated). No reachable (item kind, merge mode, status) yields
`unmatched` (rule 6).

- **GIVEN** a `stacked-prs` PR derived `conflicting`
- **WHEN** `decide` runs
- **THEN** the decision is a declared wait, not `unmatched`

### Executors

#### R8: `halt` reason per row
The `halt` executor SHALL take its reason from `Decision.Reason`, escalating `halted: <reason>`;
P2 keeps the reason `PR #<n> was closed without merging`. It still writes `halted` on the one
item and disarms that item when observed armed.

- **GIVEN** C6 fires on an armed PR
- **WHEN** `halt` runs
- **THEN** `halted` is written, `halted: PR #<n> is CONFLICTING again after the rebase recovery` is escalated, and the PR is disarmed

#### R9: `fix-request` executor
`fix-request` SHALL build the reference `fixRequest` text (`CI failed on PR #<n> (<owner/repo>):
check `<name>` — run <link>[, shard i/n].\nDiagnose and fix on this branch, push, and report the
root cause in one line.`, no skill prefix), then under the pass lock write `recovery += ci-fix`,
`fix_head` = observed head, `recovery_at` = now, then call `Env.Panes.Send`. Success acts
`recovery-sent`; `ErrPaneBusy` restores the three fields to their pre-write values and acts
nothing (the next pass retries); any other error keeps the round spent and escalates `CI fix
request delivery uncertain: <err>`. Dry run sends nothing and writes nothing.

- **GIVEN** C2 fires and `Send` returns `ErrPaneBusy`
- **WHEN** `fix-request` runs
- **THEN** the PR item has no `ci-fix` in `recovery` and no `fix_head`/`recovery_at` afterwards

#### R10: `recovery-spawn` executor
`recovery-spawn` SHALL validate the branch (`checkedBranch`) and the fix id
(`<change, else queue item id>-fix`, `itemIDRe`); in one engine-file write record the parent's
`recovery += ci-fix`, `fix_head`, `recovery_at`, `fix_item` **and** add the fix item to `fixes:`
with `spawning` set; then launch through the existing spawn path (`Env.Session`,
`worktreeForBranch`, `SpawnRequest{CheckoutBranch, ExistingWorktree, Prompt: fix text, Note:
"<fix id> · CI fix"}`), bind the pane and add the projection as queue spawns do, clearing
`spawning`. A failure after the intent write escalates and never relaunches; a fix item left with
`spawning` and no pane is F2's.

- **GIVEN** C3 fires
- **WHEN** the launch succeeds
- **THEN** exactly one window is opened, the fix item holds the pane, its projection exists, and the parent names it in `fix_item`
- **AND** a second pass opens no second window

#### R11: `rebase` executor
`rebase` SHALL: `git fetch origin`; resolve the default branch; add a temporary detached worktree
at `origin/<branch>` (never the authoring worktree, never a local branch); `git rebase
origin/<default>`. On rebase failure: collect conflict files, `git rebase --abort`, write `halted`
and `recovery += rebase` in one write, escalate `halted: rebase of <branch> onto <default>
conflicted or failed<files>: <stderr>`, disarm if armed. On success: write `recovery += rebase`,
then `git push --force-with-lease=refs/heads/<branch>:<observed headRefOid> origin
HEAD:refs/heads/<branch>`; push failure escalates (round stays spent). The temporary worktree is
removed on every exit path; a removal failure escalates. Fetch or worktree failures before the
rebase escalate without spending the round. No arm is attempted (P6 re-arms next pass). If `main`
already holds an equivalent temp-worktree helper (R6b), reuse it.

- **GIVEN** a conflicting PR whose branch rebases cleanly
- **WHEN** `rebase` runs
- **THEN** the remote branch is the rebased commit, `rebase` ∈ `recovery`, the authoring worktree is untouched, and no `gh pr merge --auto` call was made
- **AND** if the remote branch moved after observe, the push is rejected and nothing is overwritten

#### R12: `untrack` executor
`untrack` SHALL in one engine-file write remove the fix item and clear the parent's `fix_item`
when it still names that item, then remove the fix item's ledger projection. It SHALL NOT close
the fix agent's window.

- **GIVEN** a fix item whose parent PR merged
- **WHEN** `untrack` runs
- **THEN** the fix item and its projection are gone and no tmux kill was issued

### Pane send seam and CLI

#### R13: `Panes.Send`
`autopilot.Panes` SHALL gain `Send(ctx, paneID, text string) error` and the package SHALL export
`ErrPaneBusy`. `cmd/rk/operator_autopilot.go` `autopilotPanes.Send` SHALL read pane facts
(`muxSendFactsFn`), return `ErrPaneBusy` for `tmux.AgentStateActive`/`AgentStateWaiting`, else
send `inject.Sanitize(text)` with submit through `muxSendEngineSendFn` and
`inject.NewEngine(muxBufferNameFn())`. All `Panes` fakes implement `Send`.

- **GIVEN** a pane whose agent is active
- **WHEN** `Send` is called
- **THEN** it returns `ErrPaneBusy` and injects nothing

#### R14: CLI and status surface
`rk operator autopilot` help SHALL mention PR recovery; `status` SHALL list fix items with their
derived status; `step --dry-run` prints C/F rows like any row.

- **GIVEN** an engine file with a fix item
- **WHEN** `rk operator autopilot status` runs
- **THEN** the fix item appears with status `working`, `resolved` or `spawn-unknown`

### Non-Goals

- `stacked-prs` merge-all (`stale-base`, B1, `restack`, P4/P7 for stacked, removing B0) — R6b.
- Brief changes; claim/CAS machinery; hand edits of the engine file; pane-id reuse; races the pass lock rules out.
- Refunding rounds on `resume`; a second round of either kind; closing the fix agent's window.
- Review bar and rules 6–7: quoted verbatim in `intake.md` § Non-goals; every review dispatch quotes them.

### Design Decisions

#### Recovery rounds are a set of spent kinds
**Decision**: `recovery` stores the spent kinds (`ci-fix`, `rebase`) as a set on the PR engine item.
**Why**: Each kind has its own one-round budget; a later failure of the other kind must not reset it.
**Rejected**: The reference's single overwritten `recovery` value — let a rebase reset a spent ci-fix round.
*Introduced by*: 261116-m8io-autopilot-pr-recovery

#### Conflict rebase in a temporary detached worktree with a pinned lease
**Decision**: C5 rebases a detached worktree at `origin/<branch>` and pushes `HEAD:refs/heads/<branch>` with `--force-with-lease` pinned to the observed head; the round is spent just before the push.
**Why**: Never touches the authoring agent's worktree, a crash repeats cleanly, a concurrent push is never overwritten, and a transient fetch error does not burn the budget.
**Rejected**: Reusing the existing worktree (a dirty agent tree halts the PR) and spending the round before the fetch.
*Introduced by*: 261116-m8io-autopilot-pr-recovery

#### Fix items in their own engine-file list
**Decision**: Recovery-spawn agents live in a `fixes:` list, linked from the parent's `fix_item`.
**Why**: Queue derivation and readiness stay untouched; no back-link key is added.
**Rejected**: Queue items with a `fix_for` marker — every queue path would need an exclusion.
*Introduced by*: 261116-m8io-autopilot-pr-recovery

### Deprecated Requirements

#### P5 `recovery needed` escalation
**Reason**: R6c performs the recovery the escalation only reported.
**Migration**: Rows C1–C6 (failed/conflicting); `stacked-prs` conflicting is a declared wait.

## Tasks

### Phase 1: Setup

- [x] T001 Fetch the reference branch and read the port sources with `git show "origin/261114-8w1x-r6-full-reference:<path>"` (recovery.go, spawn.go `worktreeFor`/`cleanupWorktree`, merge.go `conflictFiles`, autopilot.go `Panes`/`ErrPaneBusy`, cmd/rk/operator_autopilot.go `autopilotPanes.Send`, and the recovery tests named in intake § 7); check `main` for an R6b temp-worktree helper to reuse <!-- R11 -->
- [x] T002 Add `recovery`, `fix_head`, `recovery_at`, `fix_item` to `engineItem` and the `fixes:` list to `engineState` in `internal/autopilot/enginefile.go`; carry them through `engineItemFromTracked`, `tracked()`, `applyEngineItem`, `find`/`has`/`upsert`/`remove`, `engineView` and `OwnedIDs`; add scope-key constants in `internal/autopilot/queue.go` and helpers (`roundSpent(it, kind)`, `fixParent(st, fixID)`) <!-- R1 R2 -->
- [x] T003 Add `Send` to `Panes` and `ErrPaneBusy` in `internal/autopilot/autopilot.go`; implement `Send` on `fakePanes` (`internal/autopilot/harness_test.go`, scriptable busy/error, recorded texts) and `cliPanes` (`cmd/rk/operator_autopilot_test.go`); implement `autopilotPanes.Send` in `cmd/rk/operator_autopilot.go` <!-- R13 -->

### Phase 2: Core Implementation

- [x] T004 In `internal/autopilot/status.go` add `PRFixing` (precedence after draft, before failed; view-only), the `FixStatus` type with `resolved`/`spawn-unknown`/`working` and `deriveFix`, and the pure authoring-pane helper (`authoringPane(st, f, it) (pane string, idle, known bool)` with `changeMatches`) <!-- R3 R4 R5 -->
- [x] T005 In `internal/autopilot/rules.go` add `kindFix`, the action kinds, rows C1–C6/F1/F2 with guards and reason texts, the new waits; remove P5, `stallText`, `stallGuard`; make `decide` iterate fix items; update `TestRuleTableShape`'s expected order <!-- R6 R7 -->
- [x] T006 Generalise `halt` in `internal/autopilot/execute.go` to use `Decision.Reason` (P2 sets its closed text) and dispatch the four new actions in `execute` <!-- R8 -->
- [x] T007 Create `internal/autopilot/recovery.go` with `fixRequest` text builder and the `fix-request` executor (intent write, `Send`, busy rollback, uncertain-delivery escalation, dry-run no-op) <!-- R9 -->
- [x] T008 Add the `recovery-spawn` executor in `internal/autopilot/recovery.go` reusing `spawn.go`'s launch/attach/projection path for a fix item (intent + fix item in one write, `spawning` cleared on bind) <!-- R10 -->
- [x] T009 Add the `rebase` executor in `internal/autopilot/recovery.go`: fetch, temp detached worktree, rebase, abort + halt on conflict, round write, pinned-lease push, cleanup on every path; port `conflictFiles` <!-- R11 -->
- [x] T010 Add the `untrack` executor in `internal/autopilot/recovery.go` (remove fix item, clear parent `fix_item`, remove projection, no window kill) <!-- R12 -->

### Phase 3: Integration & Edge Cases

- [x] T011 Extend `TestDecideTable` / `TestEveryStatusHasARowOrADeclaredWait` in `internal/autopilot/rules_test.go` to enumerate every (kind incl. `fix`, mode, status): C1–C6, F1, F2, busy and snapshot-unknown waits, stacked conflicting wait; replace the P5 cases; update P5 assertions in `deltas_test.go` and `merge_test.go` to the C-row behaviour <!-- R6 R7 -->
- [x] T012 [P] Add status tests in `internal/autopilot/status_test.go` for `fixing` precedence (merged wins, new head falls through), fix statuses and the authoring-pane lookup (lowest id, 4-char match, queue-item fallback, idle states, unknown snapshot) <!-- R3 R4 R5 -->
- [x] T013 Add executor tests in a new `internal/autopilot/recovery_test.go`, porting the reference cases named in intake § 7 (decision cases go to the table test): fix request sent/busy rollback/uncertain; no-push window halts; red on new head halts and disarms; recovery spawn once when the pane is gone + worktree lookup failure; F1 untrack on green/merged/halted/missing parent; rebase success (real temp repo, P6 re-arms next pass), conflict abort + halt, lease rejects a concurrent push, authoring worktree untouched, fetch failure keeps the round; separate budgets; resume does not refund <!-- R8 R9 R10 R11 R12 -->
- [x] T014 Show fix items in `autopilot status` (`internal/autopilot/status` view + `cmd/rk/operator_autopilot.go` rendering) and update the command help; extend `cmd/rk/operator_autopilot_test.go` <!-- R14 -->

### Phase 4: Polish

- [x] T015 Run gates from `app/backend`: `go vet ./...`, `just test-backend` (repo root), and `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`; fix failures (known host-only: `cmd/rk TestPortPinRowRealPolicyValues`, `rk/api TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`) <!-- R6 -->

## Execution Order

- T002 and T003 block T004–T010
- T004 blocks T005; T005 blocks T006–T011
- T007–T010 share `recovery.go` and run sequentially

## Acceptance

### Functional Completeness

- [ ] A-001 R1: PR engine items round-trip `recovery` (set), `fix_head`, `recovery_at`, `fix_item`; no ledger item ever carries them
- [ ] A-002 R2: `fixes:` list exists, fix items are excluded from queue derivation, and `OwnedIDs` includes them
- [ ] A-003 R3: `fixing` is derived exactly as specified with the stated precedence
- [ ] A-004 R4: Fix items derive `resolved` / `spawn-unknown` / `working` as specified
- [ ] A-005 R5: Authoring pane lookup is pure, deterministic (lowest id), honours idle and unknown snapshot
- [ ] A-006 R6: Rows C1–C6, F1, F2 fire with the specified guards and reasons; P5 is gone
- [ ] A-007 R7: Every reachable (kind, mode, status) has a row or declared wait; the table test enumerates them
- [ ] A-008 R8: `halt` uses the decision's reason; P2 text unchanged
- [ ] A-009 R9: `fix-request` writes intent before sending, rolls back on `ErrPaneBusy`, keeps the round on other errors
- [ ] A-010 R10: `recovery-spawn` writes intent + fix item before launch and never launches twice
- [ ] A-011 R11: `rebase` uses a temp detached worktree, pins the lease to the observed head, spends the round just before the push, halts on conflict, never arms
- [ ] A-012 R12: `untrack` removes the fix item and projection and leaves the window open
- [ ] A-013 R13: `Panes.Send` exists with `ErrPaneBusy`; production send refuses busy agents
- [ ] A-014 R14: `status` lists fix items; help mentions recovery

### Behavioral Correctness

- [ ] A-015 R6: A failed or conflicting non-stacked PR is recovered (not only escalated); a stacked conflicting PR waits
- [ ] A-016 R11: Re-arm after a recovery rebase happens via P6 on the next pass

### Removal Verification

- [ ] A-017 R6: `stallText`, `stallGuard`, row P5 and its wait reasons and `recovery needed` strings are removed from code and tests

### Scenario Coverage

- [ ] A-018 R13: Executor tests cover every scenario listed in T013 against real temp repos / scripted runner / fake panes

### Edge Cases & Error Handling

- [ ] A-019 R9: Uncertain delivery and busy rollback are both tested
- [ ] A-020 R11: Fetch failure does not spend the round; worktree cleanup failure escalates
- [ ] A-021 R3: A hand-merged PR during a fix round records merged and F1 untracks the fix item

### Code Quality

- [ ] A-022 Pattern consistency: New code follows the rules/execute/status structure and naming of `internal/autopilot`
- [ ] A-023 No unnecessary duplication: Existing helpers (`guarded`, `reread`, `launch`, `attach`, `worktreeForBranch`, `defaultBranch`, `checkedBranch`, `nameWithOwner`, mux send) are reused
- [ ] A-024 Subprocesses: All git/gh calls go through `e.git`/`e.gh` (timeouts, argument slices), never shell strings
- [ ] A-025 Comments state constraints only — no narration, no change IDs or PR numbers
- [ ] A-026 Tests: new behaviour is covered; gates in T015 pass (known host-only failures excepted)

### Security

- [ ] A-027 R13: The fix-request text is sanitised (`inject.Sanitize`) before injection; check names/links from `gh` are never executed

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | All intake assumptions carry over unchanged | Intake gate passed at 4.0; user answered the four open design questions | S:90 R:80 A:90 D:90 |
| 2 | Confident | Halt reason texts for C1/C4/C6 as written in R6 | Ported from the reference's `haltCone` reasons, with the PR number appended for C1/C4 | S:65 R:85 A:80 D:70 |
| 3 | Confident | A rebase conflict writes `halted` and `recovery += rebase` in one write | Keeps the budget truthful if the PR is resumed; one write under the pass lock | S:60 R:80 A:75 D:65 |
| 4 | Confident | PR evidence stays `No recording`; the fix request reuses the existing mux send engine unchanged | Plan: no UI change in R6c; shared delivery code is not modified, only called | S:60 R:80 A:65 D:65 |
| 5 | Confident | CI recovery and rebase refuse an unobserved empty head SHA without spending a round | `fix_head` and the force-push lease both require an observed head; spending without one would halt or push against an ambiguous state | S:80 R:75 A:80 D:75 |

5 assumptions (1 certain, 4 confident, 0 tentative).
