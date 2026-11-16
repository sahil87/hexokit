# Intake: Autopilot PR recovery (R6c)

**Change**: 261116-m8io-autopilot-pr-recovery
**Created**: 2026-11-16

## Origin

> Implement step R6c (PR recovery) of fab/plans/sahil/26-11-16-operator-autopilot-restructure.md:
> read the plan (Decisions, Engine model and rule table, R6c brief, Rules) and implement the R6c
> brief; the R6r-ii brief is merged (#1139, fab-first PR source #1140); start from the current
> main engine (rule table, own engine state file). R6b runs in parallel in another worktree and
> touches different rows/executors. Copy the review bar (incl. the R6r-ii clause) and rules 6-7
> into the intake non-goals; read the reference branch only via
> git show origin/261114-8w1x-r6-full-reference:<path>, never merge or cherry-pick it. After the
> intake, stop and report; the operator will send /fab-fff.

`/fab-new` from the operator executing the plan. No prior conversation; at intake the user
answered four SRAD questions (all four took the recommended option): C1–C4 in every merge mode
and C5–C6 not for `stacked-prs`; C5 rebases in a temp detached worktree with a lease pinned to
the observed head; C5 spends its round just before the push; fix items live in a new `fixes:`
list. The plan doc
(`fab/plans/sahil/26-11-16-operator-autopilot-restructure.md`) is the design authority: its
Decisions table, § Engine model (Pass, PR item status, Rule table and its binding consequences,
Action vocabulary, Where the model stops, Escalations are notes, Engine state file), § State-file
keys, the § R6c brief and § Rules for the operator bind this change. The apply agent SHOULD read
those sections directly; this intake restates the binding parts and records the decisions the plan
leaves open.

Starting point is `main` at `8bfea975` (R6r-ii #1139 + #1140). `app/backend/internal/autopilot/`
has the observe → derive → decide → execute shape over its own engine file:
`status.go` (statuses + facts), `rules.go` (`ruleTable`, `waitTable`, `decide`), `execute.go`
(executors incl. `halt`, `disarm`, `arm`, `merge`), `observe.go` (`stallUnchanged = 3`,
`requiredChecks`, `firstFailed`, `checksPending`), `enginefile.go` (`engineItem`, `engineState`
with `queue:`/`prs:` lists, `OwnedIDs`), `spawn.go` (`launch`, `attach`, `spawning` intent),
`repo.go` (`worktreeForBranch`, `defaultBranch`, `checkedBranch`, `nameWithOwner`),
`autopilot.go` (`Env`, `Panes` = `Snapshot` + `PID` only, `escalate`). Today a failed or
conflicting non-stacked PR fires row **P5** (`recovery needed: <ci-failed|conflicting> — PR #<n>
(<repo>)`, escalate once per head) and nothing else.

The reference engine lives on `origin/261114-8w1x-r6-full-reference` (commit `e99ca698`). Read it
**only** with `git fetch origin 261114-8w1x-r6-full-reference && git show
"origin/261114-8w1x-r6-full-reference:<path>"` (quote the argument; in zsh `$R:a…` is a
modifier — use `"${R}:path"`). Never merge or cherry-pick it. Port sources:
`app/backend/internal/autopilot/recovery.go` (`ciFailed`, `recoverySpawn`, `fixRequest`,
`authoringPane`, `changeMatches`, `progressFixRound`, `resolveFixRound`, `conflicting`, `short`,
`shardRe`), `spawn.go` (`worktreeFor`, `cleanupWorktree`), `merge.go` (`conflictFiles` at ~774),
`autopilot.go` (`Panes.Send`, `ErrPaneBusy`), `cmd/rk/operator_autopilot.go`
(`autopilotPanes.Send` over the mux send engine), and the recovery tests listed in § 7.

## Why

1. **Recovery is still a human job.** Since R6r-ii deleted `brief_autopilot.md` and the run's
   git/gh write tools, a PR whose required check fails, or that sits `CONFLICTING`, only produces
   a `recovery needed` note + `rk notify` (row P5). Nobody fixes it unattended; the sequence stalls
   until a person sends the fix request, rebases, or re-arms by hand.
2. **The reference engine's recovery was correct in intent but built for the dropped concurrency
   model.** `recovery.go` decides inside the action (claims, rollbacks, `claimToken`, one
   overwritten `recovery` value that let a later failure of the other kind reset the budget). The
   plan moves every decision into rows C1–C6/F1 and keeps executors imperative, under the
   single-writer pass lock and the engine file.
3. **Bounded and visible.** One `ci-fix` round and one `rebase` round per PR, each with its own
   budget; every exhausted path halts the cone and escalates. That keeps unattended destructive
   actions (force-push) within the review bar.

If not done: R6c is a prerequisite of F2 (deleting fab's operator), and every red or conflicting
PR in a queue keeps costing a human round-trip.

## What Changes

Behaviour not listed here stays as R6r-ii shipped it. Per rule 6 every addition is a status case,
a rule row and an executor.

### 1. Engine-file keys (plan § State-file keys, R6c row)

On **PR engine items** (`engineState.PRs`), all written only by executors under the pass lock:

```yaml
prs:
  - id: pr-41
    # … existing fields …
    recovery: [ci-fix]              # rounds spent; a set, one entry per kind: ci-fix, rebase
    fix_head: 3f2a9c1…              # headRefOid observed when the ci-fix round was spent
    recovery_at: 2026-11-16T10:40:00Z  # when the ci-fix round was spent (C1's 30-min timer)
    fix_item: ab12-fix              # the recovery spawn's fix item (C3 only)
```

- `recovery` is a **set of spent kinds**, never one overwritten value (plan § Rule table
  consequences: "Each recovery kind has its own one-round budget"). `ci-fix` spent ⇔ `ci-fix` ∈
  `recovery`; same for `rebase`.
- Reads tolerant; keys a later step stops using are ignored, never rewritten.
- `resume <id>` keeps clearing `halted`/`skipped`/`paused` only. It does **not** refund recovery
  rounds: a resumed PR whose condition persists halts again on the next pass (C1/C4/C6). Document
  this in memory (the human pushes a fix, merges by hand, or `rm`s the sequence).

**Fix items** (the recovery spawn's agent) are a new engine item kind stored in a new top-level
`fixes:` list of the engine file (same `engineItem` shape, identity/binding fields only: `id`,
`repo`, `branch`, `change`, `pane`, `session`, `spawning`, `projected`, `escalated`, `added_at`,
`updated_at`, `spawned_by`). The parent link is the parent PR item's `fix_item` (reverse lookup —
no new back-link key). Fix items never participate in queue derivation, readiness or `depends_on`.
`OwnedIDs` includes them (their projection's pane conditions are engine-owned, not judgment —
operator-loop judgment set). Their ledger projection is a `pane` item carrying binding and
identity only (rule 7), added by the existing attach/projection path.

### 2. Status: `fixing` (PR item) and fix-item statuses

PR status precedence becomes (R6b inserts `stale-base` before `draft` in parallel; whichever lands
second rebases — trivial conflict in `status.go`/`rules.go`):

`merged › paused › halted › closed › deferred › blocked › [stale-base: R6b] › draft › fixing › failed › conflicting › green › waiting`

- **`fixing`**: `ci-fix` ∈ `recovery` **and** the observed `headRefOid` equals `fix_head`. Needs
  only the PR view (not `checksRead`). Exactly the plan's row — a re-run that turns the same head
  green still reads `fixing` (the round ends only on a new head); C1 halts it after 30 min. Merged
  wins (precedence), so a hand-merge during a fix round is `merged` → P1.
- A PR whose `ci-fix` round is spent and whose head moved (≠ `fix_head`) falls through to the
  ordinary statuses: `failed` → C4, `conflicting` → C5/C6, `green` → P6/P7, `waiting` → wait.

**Fix item statuses** (new item kind `fix` in `decide`, first match):

| Status | Derived from |
|---|---|
| `resolved` | parent PR item gone, or parent derived `merged` or `halted`, or parent head ≠ `fix_head` and parent derived `green` |
| `spawn-unknown` | `spawning` set, no live pane |
| `working` | anything else (pane alive, or pane dead — the parent's C1 timer covers a dead fix agent) |

### 3. Rows (plan § Rule table; P5 removed)

| # | Item · status | Guard | Action | Intent written first |
|---|---|---|---|---|
| C1 | PR · `fixing` | `now − recovery_at > 30 min` | `halt` (reason `no new push 30m0s after the CI fix request`) | `halted` |
| C2 | PR · `failed` | `ci-fix` unspent, authoring pane alive and its agent idle | `fix-request` | `recovery += ci-fix`, `fix_head`, `recovery_at` |
| C3 | PR · `failed` | `ci-fix` unspent, no authoring pane | `recovery-spawn` | as C2, plus `fix_item` and the fix item with `spawning` |
| C4 | PR · `failed` | `ci-fix` spent (head ≠ `fix_head` by precedence) | `halt` (reason names the failed check and new head short SHA) | `halted` |
| C5 | PR · `conflicting` | `rebase` unspent, not `stacked-prs` | `rebase` onto default + `--force-with-lease`; a conflict halts | `recovery += rebase` (immediately before the push — see § 4) |
| C6 | PR · `conflicting` | `rebase` spent, not `stacked-prs` | `halt` (reason `PR #<n> is CONFLICTING again after the rebase recovery`) | `halted` |
| F1 | fix · `resolved` | — | `untrack` | — |
| F2* | fix · `spawn-unknown` | not yet escalated | `escalate` once (Q3's text shape) | dedupe key |

\* F2 is the fix-item analogue of Q3 (an intent found without its evidence is escalated, plan
§ Pass "Crash safety"); name it as the apply agent sees fit, but it must be a row.

Explicit waits (add to `waitTable`): PR `fixing` ("CI fix round in progress"); PR `failed`
("authoring agent busy" — C2's idle guard false); PR `conflicting` for `stacked-prs` ("stacked-prs:
rebase is R6b's restack"); fix `working`; fix `spawn-unknown` (already escalated). Remove P5,
`stallText`, `stallGuard` and P5's wait reasons ("already escalated for this head").

**Mode scope** (reference parity; confirmed by the user at intake): C1–C4 apply in every merge mode (the reference ran the ci-fix
round from `directMerge`, which `stacked-prs` also used). C5–C6 exclude `stacked-prs` (the
reference rebased only on the armed path; a stacked PR's base/rebase is R6b's `restack`). A
`stacked-prs` `conflicting` PR is an explicit wait.

Consequences (plan, binding): re-arm after a recovery rebase is **P6 on the next pass**, never
code inside C5; `merged` wins over an open fix round and F1 cleans up the fix item; each recovery
kind has its own budget; a halt writes one item and the cone is derived; `halt` disarms its own
armed item, P3 covers the rest.

**Authoring pane** (C2/C3 guards, pure in `decide`): from the pane snapshot already in `facts`
(rk's pane-to-change lookup, `operator.PaneInfo.Change`): the lowest pane id whose derived change
matches the PR item's `change` (`changeMatches`: equal, or the 4-char id as a `-`-delimited
segment of the folder). With no `change`, the PR's queue item (`item`) pane if alive. "Idle" =
`AgentState` not `active`/`waiting` (the reference's `ErrPaneBusy` states). A busy authoring agent
is a wait, so `step --dry-run` shows it. When the snapshot is unknown (`panesKnown == false`, the
read-only status view), neither C2 nor C3 fires (never spawn a duplicate agent because a snapshot
failed — reference `TestPaneSnapshotErrorsNeverLaunchRecovery`).

### 4. Executors (port from `recovery.go`, minus every claim/rollback/claimToken path)

All re-read the item under the store lock and skip it if its fingerprint changed (existing
`reread`/`guarded`), as every executor does. New action kinds `fix-request`, `recovery-spawn`,
`rebase`, `untrack` (plan § Action vocabulary); new `Act*` report kinds as needed (reference:
`ActRecoverySent`, `ActRecoverySpawn`, `ActRebased`).

- **`halt` generalised**: the executor takes its reason from the decision (`Decision.Reason`)
  instead of hard-coding "closed without merging"; P2 keeps that text. Escalation `halted: <reason>`.
- **`fix-request`** (C2): build the text first (`fixRequest`: `CI failed on PR #<n> (<owner/repo>):
  check `<name>` — run <link>[, shard i/n].\nDiagnose and fix on this branch, push, and report the
  root cause in one line.` — no skill prefix; it is the one sanctioned raw send into a fab-project
  agent, sent by the executor, never by a model). Write the intent (`recovery += ci-fix`,
  `fix_head` = observed head, `recovery_at` = now) under the pass lock, then
  `Env.Panes.Send(ctx, pane, text)`:
  - success → act `recovery-sent`;
  - `ErrPaneBusy` (the agent turned busy between snapshot and send; nothing was delivered) → roll
    the intent back to its pre-write values (safe: single writer under the pass lock) and wait;
    the next pass retries;
  - any other error → delivery uncertain: keep the round spent and escalate
    `CI fix request delivery uncertain: <err>` (a crash or uncertain send can lose the budget,
    never spend it twice — plan § Pass). `fixing` then waits; C1 halts after 30 min with no push.
- **`recovery-spawn`** (C3): validate the branch (`checkedBranch`) and fix id (`<change or item>-fix`,
  `itemIDRe`); in one engine-file write, record the parent intent (`recovery += ci-fix`, `fix_head`,
  `recovery_at`, `fix_item`) **and** add the fix item with `spawning` set; then launch through the
  existing spawn machinery (`launch`/`attach`, `SpawnRequest{CheckoutBranch: branch,
  ExistingWorktree: worktreeForBranch(…), Prompt: fixRequest text, Note: "<fix id> · CI fix"}`,
  session from `Env.Session`). The pane binding is written right after launch and the projection
  added, as for queue spawns. A launch that never opened rolls back only what the spawn path
  already rolls back (worktree); the fix item stays with `spawning` → F2 escalates (never
  relaunches on its own). Session/worktree lookup failure → escalate, round already spent.
- **`rebase`** (C5): do the side-effect-free preparation **before** spending the round, so a
  transient fetch failure does not burn the budget:
  1. `git fetch origin` in the repo; resolve the default branch (`defaultBranch`).
  2. Create a **temporary detached worktree** at `origin/<branch>` (`git worktree add --detach
     <tmp> origin/<branch>`), never the authoring agent's worktree and never a local branch, so a
     crash between rebase and push repeats cleanly (same principle as R6b's `restack`). Remove it
     on every exit path (`git worktree remove --force`; cleanup failure escalates, reference
     `cleanupWorktree`).
  3. `git rebase origin/<default>`; on conflict/failure collect `conflictFiles`, `git rebase
     --abort`, write `halted` and escalate `rebase of <branch> onto <default> conflicted or
     failed (<files>): <stderr>` (halt, never skip), disarming the item if armed (`halt`'s
     existing tail). The `rebase` round is spent by that halt path too.
  4. Write the intent `recovery += rebase` under the pass lock.
  5. `git push --force-with-lease=refs/heads/<branch>:<observed headRefOid> origin
     HEAD:refs/heads/<branch>` — the lease is pinned to the head this pass observed, so a fix the
     agent pushed meanwhile is never overwritten. Push failure → escalate; round stays spent; a
     still-`CONFLICTING` PR then halts via C6.
  6. Act `rebased`. **No re-arm here** — P6 arms on the next pass.
  If R6b has merged first with a shared temp-worktree/rebase helper, reuse it instead of adding a
  second one (check `main` at apply time).
- **`untrack`** (F1): one engine-file write removes the fix item and clears the parent's
  `fix_item` (if the parent still names it); then remove the fix item's ledger projection. The
  fix agent's window is **not** closed (its one-line root-cause report lives there; the user
  closes it).

### 5. Pane send seam

- `autopilot.Panes` gains `Send(ctx, paneID, text string) error`; `ErrPaneBusy` sentinel.
- `cmd/rk/operator_autopilot.go` `autopilotPanes.Send`: port the reference (read the pane's send
  facts, `ErrPaneBusy` for `tmux.AgentStateActive`/`AgentStateWaiting`, otherwise the mux send
  injection engine with `inject.Sanitize(text)` and Enter) using the current names of those
  helpers on `main` (`muxSendFactsFn`, `inject.NewEngine`, `muxSendEngineSendFn` — verify).
- Test fakes (`cliPanes` in `cmd/rk/operator_autopilot_test.go`, the autopilot harness fake) gain
  `Send` with scriptable busy / error / ok and a record of sent texts.

### 6. CLI, status, docs

- `rk operator autopilot` help/Short: mention PR recovery (fix request, recovery spawn, rebase);
  `status` lists fix items with their derived status; `step --dry-run` prints C/F rows like any
  row.
- Remove memory/help text that says recovery is escalated only (P5) or is "R6c's".

### 7. Tests (rule 6 + plan § R6c brief)

- **`decide` table test** extended to every reachable (item kind, merge mode, status), including
  PR `fixing` and the C/F rows in all three modes (`cherry-pick-ladder`, `merge-auto`,
  `stacked-prs`), the `stacked-prs` `conflicting` wait, the busy-authoring wait, snapshot-unknown,
  and the new `fix` kind (`resolved`, `spawn-unknown`, `working`). No `unmatched` row.
- **Port** the reference recovery tests: where they test a decision, as `decide` cases; where
  they test git/gh/pane effects, as executor tests (real temp repos for rebase/push/conflict, the
  scripted runner fake for `gh`, fake `Panes.Send`, fake spawner). From `merge_test.go`:
  `TestLadderCIFailedRecovery`, `…CIStillRedOnANewHeadHaltsAndDisarms`,
  `…CINoPushWithinTheWindowHalts`, `…CIFixDefersWhenTheAgentIsBusy`,
  `…CIFixSpawnsOnceWhenThePaneIsGone`, `…ConflictingRecoveryRebasesRearmsThenHaltsIfItRecurs`
  (re-arm now via P6 next pass), `…ConflictingRebaseConflictAbortsAndHalts`; from
  `revised_rules_test.go`: `TestFixRoundFailedPendingGreen`, `…FailedPendingRedOnNewHead`,
  `…NoPushBoundIncludesPendingChecks`, `TestConflictingRejectsMalformedSharedBranch`; from
  `escalation_test.go`: `TestWorktreeLookupFailurePreventsRecoverySpawn`,
  `TestRecoveryCleanupFailuresEscalate`; from `lifecycle_test.go`:
  `TestPaneSnapshotErrorsNeverLaunchRecovery`, `TestRecoveryAndRespawnAttachFailuresAreAdopted`
  (adapt to `spawning` + F2). **Drop** the claim/overlap tests the pass lock rules out
  (`TestOverlappingStepsClaimOnlyOneRecoverySpawn`, `TestStaleRecoverySnapshotCannotClaim`,
  `TestBusyRecoveryRollbackFailureKeepsRoundPending`, `TestRecoveryDeliveryWriteFailureKeepsPendingClaim`,
  `TestFixRoundCleanupWriteFailureIsAtomic`, `TestWorktreeCleanupFailureRetainsRecoverableClaim`)
  unless a single-writer analogue still asserts something real.
- New: separate budgets (a `ci-fix` round does not consume `rebase` and vice versa); merged wins
  over an open fix round + F1 untracks; resume does not refund rounds; the lease is pinned to the
  observed head (a concurrent push makes the force-push fail, nothing overwritten); rebase in a
  temp detached worktree leaves the authoring worktree untouched; `ErrPaneBusy` rolls the intent
  back; uncertain send keeps the round; fetch failure before the intent does not spend the round.
- Remove P5 tests/fixtures or convert them to C-row cases.
- **Gates**: `just test-backend` plus
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`
  (from `app/backend`; CI has no git identity — `internal/autopilot/main_test.go` already pins a
  hermetic git environment). Known host-only failures (`cmd/rk TestPortPinRowRealPolicyValues`,
  `rk/api TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`) do not block.
- **PR evidence**: `No recording: internal CLI/engine behavior`.

### Non-goals (binding — copied from the plan)

**Review bar** (plan § Decisions, verbatim, incl. the R6r-ii clause) — every review dispatch
quotes it:

> **Must-fix**: anything that can merge, arm, push, force-push or delete the wrong thing; lose or
> corrupt state-file data; launch a duplicate agent *under the single-writer rule*; crash the CLI;
> or break a requirement in the step's plan. **Should-fix** (does not block): failure cases the
> pass lock rules out, tmux pane-id reuse, missing escalations for read-only probes, and cosmetics.
> From R6r-ii, a finding that needs an external write to the engine file (a hand edit) is out of
> scope.

**Rule 6** (plan § Rules for the operator, verbatim):

> From R6r-i on, autopilot behaviour is added only as a status case, a rule row and an executor.
> A `decide` table test enumerates every reachable (item kind, merge mode, status) and asserts the
> row that fires, or an explicit `wait`. A behaviour outside the table, or a reachable combination
> with no outcome, is must-fix.

**Rule 7** (plan § Rules for the operator, verbatim):

> From R6r-ii on, the engine file is written only under the pass lock. A step never adds an engine
> key to a ledger item, and never reads a ledger item's `scope` for a decision beyond the
> projection keys listed in § Engine state file.

Also out of scope for this step:

- `stacked-prs` merge-all — status `stale-base`, row B1, the `restack` executor, P4/P7 for stacked,
  removing B0's `restack needed` — is **R6b**, running in parallel. Do not touch R6b's rows or
  executors; expect only small textual conflicts in `status.go`/`rules.go`/`operator-autopilot.md`.
- Brief changes (R6r-ii deleted the autopilot brief; the run never performs recovery).
- Claim/marker/CAS machinery from the reference engine, races the pass lock rules out, hand edits
  of the engine file, tmux pane-id reuse.
- Refunding recovery rounds on `resume`; a second `ci-fix` or `rebase` round; closing the fix
  agent's window.
- Deleting the reference branch (done by hand once R6b and R6c have merged).

## Affected Memory

- `run-kit/operator-autopilot`: (modify) PR status `fixing`; rows C1–C6, F1 (+ the fix-item
  spawn-unknown escalation) and their executors (`fix-request`, `recovery-spawn`, `rebase`,
  `untrack`); fix items (`fixes:` list, projection, `OwnedIDs`); engine-file keys `recovery` (set),
  `fix_head`, `recovery_at`, `fix_item`; `halt` reasons per row; `Panes.Send` + `ErrPaneBusy`;
  resume does not refund rounds; remove P5 and the "stall is an escalation until PR recovery
  lands" decision; update the R6b/R6c out-of-scope list (only R6b remains).
- `run-kit/operator-state`: (modify) only if it enumerates engine-file lists/owned ids — add the
  `fixes:` list / fix-item projections; otherwise unchanged.

## Impact

- **Backend Go** (`app/backend`): `internal/autopilot/` — `status.go` (`PRFixing`, fix-item
  statuses, authoring-pane fact helper), `rules.go` (C1–C6, F1, fix-item escalation row, waits,
  new `ActionKind`s, `kindFix`, remove P5), `execute.go` (dispatch + generalised `halt`),
  new `recovery.go` (executors), `enginefile.go` (`fixes:` list, PR keys, `OwnedIDs`),
  `observe.go` (fix-item observation if needed), `autopilot.go` (`Panes.Send`, `ErrPaneBusy`,
  `Act*`), `step.go`/`status` view for fix items, tests. `cmd/rk/operator_autopilot.go`
  (`autopilotPanes.Send`, help) + its test fake.
- **Docs**: `docs/memory/run-kit/operator-autopilot.md` (and possibly `operator-state.md`).
- **On-disk**: engine file gains optional PR keys and a `fixes:` list; tolerant reads; no
  migration.
- **Parallel work**: R6b edits the same status/rule tables (different rows) — merge order either
  way.
- **Size**: M per the plan.

## Open Questions

- `fixing` holds until a new head even if a re-run turns the same head green; C1 then halts after
  30 min. Kept exactly as the plan's row; a "green wins over fixing" refinement would be a plan
  change, not an R6c decision.
- C5/C6 exclude `stacked-prs` (explicit wait; decided at intake). Once R6b lands, a stacked head
  that is current on the default branch and `CONFLICTING` could reuse C5; revisit after both merge.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Rows C1–C6 and F1, status `fixing`, executors `fix-request`/`recovery-spawn`/`rebase`/`untrack`, remove P5 | Plan § Rule table + R6c brief, binding | S:95 R:80 A:95 D:95 |
| 2 | Certain | Review bar (incl. R6r-ii clause) and rules 6–7 copied verbatim into non-goals | User instruction + plan rule 2 | S:100 R:90 A:100 D:100 |
| 3 | Certain | Reference read only via `git show "origin/261114-8w1x-r6-full-reference:<path>"`; port minus claim code, never merge/cherry-pick | User instruction + plan rule 4 | S:100 R:85 A:100 D:100 |
| 4 | Certain | `recovery` is a set of spent kinds (`ci-fix`, `rebase`), each a one-round budget | Plan § Rule table consequences ("each recovery kind has its own one-round budget") | S:90 R:70 A:90 D:85 |
| 5 | Certain | Re-arm after a recovery rebase is P6 on the next pass; no arm inside C5 | Plan § Rule table consequences, binding | S:95 R:80 A:95 D:95 |
| 6 | Certain | Fix items live in a new `fixes:` list of the engine file; parent link by reverse lookup of `fix_item` (no `fix_for` key); projection = binding-only pane item; `OwnedIDs` includes them | Asked — user chose the new `fixes:` list over queue items with a `fix_for` marker; keeps queue derivation untouched, adds no unlisted key | S:90 R:70 A:80 D:90 |
| 7 | Confident | Fix-item kind has statuses `resolved`/`spawn-unknown`/`working`; a Q3-shaped escalate-once row for `spawn-unknown`; F1 also fires when the parent item is gone | Plan § Pass crash safety (intent without evidence is escalated) + rule 6 needs an outcome for every reachable status | S:55 R:65 A:70 D:60 |
| 8 | Confident | C2 guard requires the authoring agent idle (snapshot `AgentState` not active/waiting); busy is an explicit wait; a send-time `ErrPaneBusy` rolls the intent back; any other send error keeps the round spent and escalates | Reference deferred on busy; single writer makes rollback safe; plan "a crash can lose a budget, never spend it twice" | S:60 R:70 A:70 D:55 |
| 9 | Confident | Neither C2 nor C3 fires when the pane snapshot is unknown | Reference `TestPaneSnapshotErrorsNeverLaunchRecovery`; review bar (duplicate agent) | S:70 R:75 A:80 D:75 |
| 10 | Certain | C5 rebases in a temporary detached worktree at `origin/<branch>` and pushes `HEAD:refs/heads/<branch>` with `--force-with-lease` pinned to the observed `headRefOid` | Asked — user chose this over the reference's reuse of the agent's worktree; matches the plan's R6b note and the review bar | S:90 R:70 A:80 D:90 |
| 11 | Certain | C5 spends the `rebase` round after the side-effect-free fetch/rebase and immediately before the push; a rebase conflict halts (round spent via the halt) | Asked — user chose spend-before-push over literal intent-first; the push is the non-idempotent effect | S:90 R:75 A:80 D:90 |
| 12 | Confident | C1–C4 apply in every merge mode; C5–C6 exclude `stacked-prs` (explicit wait) | Asked — user chose this over all-modes and no-stacked; reference parity (ci-fix via `directMerge`, rebase only on the armed path) | S:90 R:70 A:75 D:90 |
| 13 | Confident | `halt` executor takes its reason from the decision; P2 keeps "closed without merging" | C1/C4/C6 need distinct halt reasons; smallest generalisation | S:65 R:85 A:85 D:75 |
| 14 | Confident | `resume` does not refund recovery rounds; a persisting condition re-halts next pass | Plan defines `resume` as clearing `halted`/`skipped` only | S:60 R:75 A:70 D:65 |
| 15 | Confident | F1 `untrack` removes the fix item + projection and clears the parent's `fix_item`, but does not close the fix agent's window | Reference removed only the tracking item; the agent's root-cause report lives in the window | S:55 R:80 A:70 D:60 |
| 16 | Certain | `Panes` gains `Send`; production `autopilotPanes.Send` ported from the reference over the mux send engine; fix request is the one raw send, by the executor | Plan R6c brief + reference `cmd/rk/operator_autopilot.go` | S:85 R:75 A:85 D:85 |
| 17 | Confident | PR evidence: `No recording: internal CLI/engine behavior` | Plan pipeline notes: only R6r-ii changed the drawer; R6c has no UI change | S:70 R:90 A:70 D:80 |

17 assumptions (9 certain, 8 confident, 0 tentative, 0 unresolved).
