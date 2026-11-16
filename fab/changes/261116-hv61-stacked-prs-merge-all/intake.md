# Intake: Stacked-PRs Merge-All (R6b)

**Change**: 261116-hv61-stacked-prs-merge-all
**Created**: 2026-11-16

## Origin

> Implement step R6b (stacked-prs merge-all) of fab/plans/sahil/26-11-16-operator-autopilot-restructure.md: read the plan (Decisions, Engine model and rule table, R6b brief, Rules) and implement the R6b brief; the R6r-ii brief is merged (#1139, fab-first PR source #1140); start from the current main engine (rule table, own engine state file). R6c runs in parallel in another worktree and touches different rows/executors. Copy the review bar (incl. the R6r-ii clause) and rules 6-7 into the intake non-goals; read the reference branch only via git show origin/261114-8w1x-r6-full-reference:<path>, never merge or cherry-pick it. After the intake, stop and report; the operator will send /fab-fff.

One-shot, operator-driven. The binding design source is the plan doc
`fab/plans/sahil/26-11-16-operator-autopilot-restructure.md` — read its § Decisions, § Engine model
(Pass, PR item status, Rule table, Action vocabulary, Where the model stops, Escalations are notes,
Engine state file), § Rules for the operator executing this plan, and § Briefs → R6b before
planning. This intake restates what matters and pins the open details found by reading `main`
(`8bfea975`) and the reference branch.

**Branch base**: current `main` after R6r-ii (#1139) and #1140. R6c runs concurrently in another
worktree off the same `main`; it adds rows C1–C6/F1, removes P5, and adds the `fix-request`,
`recovery-spawn`, `rebase`, `untrack` executors. R6b must stay out of those rows and executors
so both can merge in either order (see § Coordination with R6c).

## Why

1. **The problem.** A `stacked-prs` queue builds a chain of PRs where each PR's base is its
   dependency's branch. Today (`main`, R6r-ii) `rk operator autopilot merge` builds the chain,
   but for a stacked sequence only rows P1, P2, P3 and the interim **B0** fire: when a
   predecessor merges, B0 escalates `restack needed: PR #<n>` and nothing retargets, rebases,
   readies or merges the successor. R6r-ii also removed every git/gh write tool from the model
   run's brief, so nobody performs the restack unattended — the user must do it by hand for
   every PR in the stack.
2. **Consequence of not doing it.** `stacked-prs` merge-all stays a manual, error-prone
   multi-step chore (retarget, `rebase --onto`, force-push, wait for CI, merge, repeat). F2
   (deleting fab's operator) depends on R6b, so the series cannot finish without it.
3. **Why this approach.** The plan binds the shape: from R6r-i on, autopilot behaviour is added
   only as a derived status, a rule row and an executor (rule 6). R6b is exactly that: status
   `stale-base`, row B1 with the `restack` executor, and widening P4/P7 to stacked PRs. Deriving
   `stale-base` from GitHub + git every pass (instead of the reference engine's stored `prepared`
   marker) means the restack can never repeat and a crash anywhere is re-derived on the next pass
   — no marker, no claim. The executor body is **ported** from the reference branch's
   `prepareStacked` (about 70 % reusable), adapted to the single-writer pass lock, the engine
   file and the rule table.

## What Changes

### 1. Derived status `stale-base` (status.go, observe.go)

Add `PRStaleBase PRStatus = "stale-base"` to the PR status precedence, **after `blocked` and
before `draft`** (the plan's PR status table order):

```
merged › paused › halted › closed › deferred › blocked › stale-base › draft › failed › conflicting › green › waiting
```

Update `allPRStatuses`, the `derivePR` / `prPrecheck` doc comments, and `prPrecheck` so a stacked
PR whose stale-base facts are not settled is never derived `draft`/`green` from incomplete facts.

**Definition** (plan, PR item status table): `stacked-prs`, and **the base is not the default
branch, or the predecessor's `mergeCommit` is not an ancestor of the head**.

- "Predecessor" = the in-sequence PR item named in the PR item's `depends_on` (same `merge_seq`).
  Because `blocked` precedes `stale-base`, a `stale-base` PR's upstream PR items are all
  recorded merged (`done_at`, row P1) by construction.
- New facts, read only for a stacked sequence head that reaches this point (not `deferred`, not
  blocked, not halted):
  - the head's `baseRefName` — add it to `prViewFields` (`number,url,state,isDraft,mergedAt,mergeable,headRefOid,autoMergeRequest,baseRefName`) and to `prView`;
  - the repo's default branch (`e.defaultBranch`, already cached per repo per pass);
  - the predecessor PR's `mergeCommit` (`gh pr view <pred-n> --repo <nwo> --json mergeCommit`)
    — the plan's § Pass already allows "each merge sequence's head PR plus its predecessor";
    the memory file's current sentence "A sequence head's predecessor is not read" changes;
  - whether that merge commit is an ancestor of the head's `headRefOid`.
    <!-- assumed: ancestry is read via the GitHub compare API (`gh api repos/<nwo>/compare/<mergeCommit>...<headRefOid>`, status `ahead`/`identical` ⇒ ancestor) rather than a git fetch in observe — keeps observe free of local-git mutation; plan may choose `git fetch` + `merge-base --is-ancestor` instead -->
- **Unknown is never green.** If any of these facts cannot be read (gh error, missing merge
  commit, unreadable output), the item derives `waiting` for this pass and the read failure
  escalates like the existing `gh pr view failed: …` reads. A stacked PR is never derived
  `green` (and so never merged) unless the pass has positively established base == default and
  ancestry true.
- Non-stacked PRs never derive `stale-base` and never pay these reads.

### 2. Row B1 and the `restack` action (rules.go)

- Add `ActionRestack ActionKind = "restack"` to the action vocabulary.
- **Delete the interim row B0** (`restackGuard`, `restackText`, the `restack needed: PR #<n>`
  escalation). Previously-written `escalated` dedupe entries for that key are left on disk
  (tolerated, never read — State-file keys rule "Keys a step stops using are ignored by later
  code, never rewritten").
- Add **B1**: `PR · stale-base`, guard **predecessor merged** (an in-sequence `depends_on` PR item
  is merged/`done_at`), action `restack`. Placement in `ruleTable`: after P3, before P4 (where B0
  sat), so the table order matches the plan: P1, P2, P3, B1, P4, …, P7.
- A `stale-base` PR whose guard is false (no in-sequence predecessor — e.g. a chain head whose
  base is not the default branch) must still have an outcome under rule 6.
  <!-- assumed: no-predecessor stale-base gets an escalate-once row (e.g. B2: `escalate` "stacked PR #<n> is based on <base>, not <default>, and has no merged predecessor to restack from", dedupe key per reason) rather than a silent wait — a stacked PR on a non-default base must never merge, and a silent wait would hide it -->
- **P4** (`ready`): drop the `!stacked(c)` guard — a stacked draft is readied like any other. The
  `waitTable` entry `{kindPR, PRDraft, "stacked-prs: merged by R6b"}` is removed (P4 is now
  unconditional for `draft`).
- **P6** (`arm`): **unchanged** — keeps `!stacked(c)`. A stacked PR is never armed: an armed
  stacked PR can merge into its dependency's branch, or fire on stale-green checks after a
  retarget (fab-operator §6).
- **P7** (`merge`): drop the `!stacked(c)` clause from `mergeGuard`. For a stacked PR it fires
  only on `green`, which (§1) can only be derived after base == default and ancestry hold,
  on the **current** head (`--match-head-commit <observed headRefOid>`, as today). Since
  `stale-base` precedes `green`, B1 and P7 can never fire on the same pass for the same PR —
  the merge waits for the next pass by construction.
- Update `waitTable` so every reachable (PR, `stacked-prs`, status) has a row or a declared wait
  with a truthful reason (e.g. `stale-base` when its rows are guarded out; `green` armed or head
  unknown; `waiting` for stacked: "checks pending or stacked-prs (never armed)").

### 3. The `restack` executor (new file, e.g. `restack.go`)

Ported from the reference branch's `prepareStacked` (`git show "origin/261114-8w1x-r6-full-reference:app/backend/internal/autopilot/merge.go"`, lines ~685–771; `retarget` from `idempotent.go` ~41–58; `conflictFiles` from `merge.go` ~774), **minus** the claim code (`claimWork`, `finishWorkClaim`, `claimStacked`), the `prepared` marker and `worktreeFor`'s claim-mutating bookkeeping. Steps:

1. `reread(d)` — skip if the item changed or vanished since observe (external writes win), as
   every executor does.
2. Validate branches with `checkedBranch` (head branch, predecessor branch).
3. `git fetch origin` in the repo; a failed fetch escalates and stops (no rebase on stale refs).
4. Resolve the default branch (`e.defaultBranch`).
5. **Verify or perform the retarget**: if the observed `baseRefName` ≠ default, `gh pr edit <n>
   --repo <nwo> --base <default>` (plain branch name, never a remote ref), with the reference's
   postcondition check (`base branch was not changed` / `already` ⇒ re-read `baseRefName` and
   accept only if it equals default). GitHub retargets automatically when the merged base branch
   was deleted; then this step is a no-op.
6. **Rebase from `origin/<branch>`, never a local branch**: do the rebase in a fresh temporary,
   detached worktree created from `origin/<branch>` (`git worktree add --detach <tmp> origin/<branch>`),
   so the authoring agent's own worktree (which has `<branch>` checked out) is never touched and a
   crash between the rebase and the push repeats cleanly from the remote.
   `git rebase --onto origin/<default> <upstream> HEAD`, where `<upstream>` is the predecessor's
   pre-merge head (the commits the default branch now holds only as a squash).
   <!-- assumed: <upstream> = the predecessor PR's `headRefOid` (readable after merge via gh, fetchable as `refs/pull/<n>/head` even when the merged branch was deleted), falling back to `origin/<pred-branch>` — the reference used resolveRef(prevBranch) (local then remote branch), which breaks when GitHub auto-deleted the merged branch -->
7. **Conflict halts, never skips**: on rebase failure collect `conflictFiles`, `git rebase
   --abort` (escalate if the abort itself fails), write `halted` on this one item (intent first,
   via the same `guarded` write the `halt` executor uses), escalate
   `halted: rebase of <branch> onto <default> failed: <files> (cleanup attempted, not skipped): <stderr>`,
   and disarm if armed. The cone is derived from that one write.
8. **Push**: `git push --force-with-lease=refs/heads/<branch>:<observed headRefOid> origin HEAD:refs/heads/<branch>`.
   The explicit lease SHA is the head observed this pass, so a push by the authoring agent in the
   meantime makes the push fail (escalate, no halt) instead of being overwritten.
9. Always remove the temporary worktree (`git worktree remove --force` + prune); a cleanup
   failure escalates.
10. Record actions for the CLI: add `ActRetargeted` / `ActRebased` act kinds (as the reference
    had) so `step` output shows `retargeted PR #<n> → <default>` and `rebased <branch> onto <default>`.

**No intent marker**: `restack` is idempotent per the plan (§ Pass, crash safety). A crash after
the retarget leaves base == default but ancestry false ⇒ still `stale-base` ⇒ B1 again (retarget
verified as no-op, rebase repeats from `origin/<branch>`). A crash after the push ⇒ next pass
derives ancestry true ⇒ B1's guard is false forever after, so the restack never repeats.
**No new engine-file key.**

`--dry-run`: `decide` output shows `B1 restack`; the executor runs nothing (existing dry-run
behaviour of `execute`).

### 4. Observe changes (observe.go)

- For a stacked sequence head that reaches the check statuses' precondition, read the stale-base
  facts (§1) before checks; a `stale-base` head need not read checks.
- Keep "one fact read per item per pass": the predecessor's `mergeCommit` read counts as the
  predecessor's read.
- The repo auto-merge read stays skipped for stacked PRs (already the case).

### 5. CLI help and chat skill text

- `cmd/rk/operator_autopilot.go`: the `--mode` list line "register chains with merge; restacks
  escalate until supported" and the `merge` long help ("escalate restacks; they are never armed or
  merged in this step") change to describe the real behaviour: stacked PRs are readied, restacked
  (retarget + `rebase --onto` + `--force-with-lease`) after their predecessor merges, and merged
  directly (never armed) once green on the restacked head; a rebase conflict halts and escalates.
- `app/backend/cmd/rk/skill/operator.md` lines ~130–132: drop "report an `escalated: restack
  needed` … note" and "a stacked predecessor merge produces a restack escalation … until
  restacking is handled outside this step"; keep "never perform mechanical work from chat".
  `docs/site/skill/operator.md` is a byte-identical mirror (`scripts/sync-skill.sh`) — keep them in
  sync.
- No brief change (R6r-ii deleted the autopilot brief; the brief only renders notes).

### 6. Tests

- **`decide` table test (rule 6)** in `rules_test.go`: enumerate every reachable (item kind, merge
  mode, status) including `stale-base` and assert the row or explicit wait. Replace the B0 case
  ("merged predecessor escalates stacked restack only (B0)") with B1 cases; update the row-order
  assertion (`want := []string{… "P3", "B1", "P4", …}`); add: stacked draft ⇒ P4; stacked green ⇒
  P7; stacked waiting ⇒ never P6; stale-base with merged predecessor ⇒ B1; stale-base without
  predecessor ⇒ the no-predecessor outcome; stale-base facts unreadable ⇒ `waiting`, never
  `green`/P7.
- **Executor tests** against real temp repos (bare `origin` + clone, `main_test.go`'s hermetic git
  identity) and the scripted gh runner fake, ported from the reference `merge_test.go`:
  `TestStackedMergesStepByStepRetargetsAndRebases`, `TestStackedKeepsAnExistingRetargetUntouched`,
  `TestStackedRebaseConflictHaltsNeverSkips`, `TestStackedNeverMergesInThePassThatMutatedThePR`,
  `TestStackedReadiesADraftBeforeMerging` — minus claim/`prepared` assertions. Add: restack starts
  from `origin/<branch>` even when a local `<branch>` diverges; the lease refuses when the remote
  head moved since observe; a crash between rebase and push (simulated push failure) repeats
  cleanly next pass; the predecessor branch deleted on the remote still restacks; restack never
  repeats once ancestry holds.
- Gates: `just test-backend` plus
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`.
  Known host-only failures (`TestPortPinRowRealPolicyValues`, `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`) do not block.

### 7. Coordination with R6c (parallel worktree)

R6b and R6c share only `status.go` (status list) and `rules.go` (rule table, wait table, action
constants). To keep both mergeable in either order with trivial conflicts:

- R6b does **not** touch P5, the `failed`/`conflicting` rows or their waits, `stallGuard`/
  `stallText`, or anything in R6c's executors. A stacked `failed`/`conflicting` PR keeps today's
  outcome (P5 is guarded `!stacked`, so it is a declared wait); R6c's rows decide it.
  <!-- assumed: R6b leaves stacked failed/conflicting PRs on their current declared wait (no escalation) and leaves recovery for stacked PRs to R6c — widening P5 to stacked would collide with R6c deleting P5 -->
- R6b does **not** generalize the `halt` executor's hard-coded "closed without merging" reason
  (R6c will likely need that); the restack executor writes `halted` + escalation itself in its
  own file.
- New code goes in a new file (`restack.go` + `restack_test.go`); edits to `rules.go`/`status.go`
  are confined to the stale-base status, B0→B1, P4/P7 guards and their waits.

### Non-goals (binding — plan § Decisions "Review bar" and § Rules 6–7, quoted)

**Review bar** — *"**Must-fix**: anything that can merge, arm, push, force-push or delete the
wrong thing; lose or corrupt state-file data; launch a duplicate agent *under the single-writer
rule*; crash the CLI; or break a requirement in the step's plan. **Should-fix** (does not
block): failure cases the pass lock rules out, tmux pane-id reuse, missing escalations for
read-only probes, and cosmetics. From R6r-ii, a finding that needs an external write to the
engine file (a hand edit) is out of scope."* Every review dispatch for this change quotes this
bar.

**Rule 6** — *"From R6r-i on, autopilot behaviour is added only as a status case, a rule row and
an executor. A `decide` table test enumerates every reachable (item kind, merge mode, status)
and asserts the row that fires, or an explicit `wait`. A behaviour outside the table, or a
reachable combination with no outcome, is must-fix."*

**Rule 7** — *"From R6r-ii on, the engine file is written only under the pass lock. A step never
adds an engine key to a ledger item, and never reads a ledger item's `scope` for a decision
beyond the projection keys listed in § Engine state file."*

Also out of scope:
- PR recovery (C1–C6, F1, removing P5, `fix-request`/`recovery-spawn`/`rebase`/`untrack`) — R6c.
- Any claim machinery, CAS snapshots, or overlapping-pass handling — the single-writer pass lock
  rules that class out.
- The reference engine's `prepared` marker or any new engine-file key.
- Arming a stacked PR (P6 stays non-stacked).
- Brief changes (none exist to make).
- Dependency-branch drift after a dependent PR exists (fab-operator §6 declares it out of scope).
- Merging or cherry-picking the reference branch: read it only with
  `git fetch origin 261114-8w1x-r6-full-reference && git show "origin/261114-8w1x-r6-full-reference:<path>"`
  (quote it; in zsh `$R:path` is a modifier — use `"${R}:path"`). Deleting the reference branch is
  nobody's chore in this step.

## Affected Memory

- `run-kit/operator-autopilot`: (modify) PR status table gains `stale-base`; rule table B0 → B1
  (`restack`), P4/P7 widened to `stacked-prs`, P6 unchanged; observe reads `baseRefName`, the
  predecessor's `mergeCommit` and ancestry for stacked heads; the `restack` executor (retarget
  verify, detached worktree from `origin/<branch>`, `rebase --onto`, explicit-SHA
  `--force-with-lease`, conflict halts); the "Merge … stacked-prs chains" requirement, the
  out-of-scope bullet "stacked-prs merge-all … is R6b", and the escalation Design Decision drop
  `restack needed`; the description line drops "B0" and "what R6b … still own(s)".
- `run-kit/index`: (modify) the operator-autopilot row's description (B0 → B1, R6b no longer pending).

## Impact

- **Code**: `app/backend/internal/autopilot/` — `status.go` (status + precedence), `observe.go`
  (stale-base facts), `gate.go` (`prView.BaseRefName`, possibly `MergeCommit`), `rules.go` (B0
  removal, B1, P4/P7 guards, wait table, `ActionRestack`), `execute.go` (dispatch `ActionRestack`),
  `autopilot.go` (`ActRetargeted`, `ActRebased`), new `restack.go` (+ maybe `retarget` in
  `idempotent.go`), `merge.go` comment on stacked acceptance.
- **Tests**: `rules_test.go`, `status_test.go`, `merge_test.go` and/or new `restack_test.go`,
  `harness_test.go` fakes for the new gh calls (`pr view --json mergeCommit`, `pr edit --base`,
  compare API if used).
- **CLI**: `cmd/rk/operator_autopilot.go` help text; `cmd/rk/skill/operator.md` +
  `docs/site/skill/operator.md` mirror.
- **Behaviour**: destructive and unattended — the daemon's mechanical pass will now retarget,
  rebase, force-push and merge stacked PRs. Protections: `merge_mode` per queue, conflict halts,
  `autopilot stop` disarms durably, `step --dry-run` shows B1/P7 before acting.
- **PR evidence**: no UI change — `No recording: internal CLI/engine behavior`.
- **Release**: no cross-repo dependency; F2 (fab-kit) unblocks once R6b and R6c ship.

## Open Questions

- Ancestry check source: GitHub compare API in observe vs. `git fetch` + `merge-base
  --is-ancestor` (plan decides; both satisfy "derived each pass").
- Exact wording/row id for the no-predecessor `stale-base` outcome (B2 escalate-once vs. a
  declared wait with a status-view reason).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope = plan's R6b brief: status `stale-base`, row B1 + `restack` executor, P4/P7 for stacked, P6 never for stacked, remove interim `restack needed` (B0); no brief change; no new engine-file key; no claim code | Plan § Briefs R6b and § Rule table are explicit; user said implement the R6b brief | S:95 R:80 A:95 D:95 |
| 2 | Certain | Review bar (incl. the R6r-ii hand-edit clause) and rules 6–7 copied verbatim into non-goals; every review dispatch quotes the bar | Plan § Rules 2, user instruction | S:95 R:90 A:95 D:95 |
| 3 | Certain | Reference branch read only via `git show "origin/261114-8w1x-r6-full-reference:<path>"`; never merged or cherry-picked; executor body ported from `prepareStacked` | Plan rule 4 and user instruction | S:95 R:85 A:95 D:95 |
| 4 | Certain | `stale-base` sits after `blocked`, before `draft` in PR precedence; B1 sits after P3, before P4 (replacing B0) | Plan PR status table and rule table order | S:90 R:85 A:90 D:90 |
| 5 | Certain | Unknown stale-base facts derive `waiting`, never `green`; stacked P7 can only fire after base == default and ancestry are positively observed this pass | Review bar: merging into the wrong base is must-fix; plan "green derived on the current head each pass" | S:75 R:80 A:85 D:80 |
| 6 | Confident | Restack runs in a temporary detached worktree from `origin/<branch>`, pushes `HEAD:refs/heads/<branch>` with `--force-with-lease=<branch>:<observed headRefOid>` | Brief: "starts from origin/<branch>, never a local branch"; the authoring worktree holds the branch checked out; explicit lease prevents overwriting a concurrent agent push (must-fix class) | S:70 R:75 A:75 D:65 |
| 7 | Confident | Rebase conflict: abort, write `halted` on the one item, escalate with conflict files, disarm if armed — never skip; push/fetch/retarget failures escalate without halting | Brief + fab-operator §6 "halts and escalates (never skips)"; matches the reference's split between halt (conflict) and escalate (transient) | S:80 R:75 A:80 D:75 |
| 8 | Confident | R6b leaves P5, failed/conflicting rows, stallGuard and the `halt` executor's reason untouched; new code in `restack.go` | User: R6c runs in parallel on different rows/executors; plan: R6b/R6c share only status derivation + rule table | S:80 R:70 A:75 D:70 |
| 9 | Certain | Help text in `operator_autopilot.go` and the chat skill (`cmd/rk/skill/operator.md` + `docs/site/skill/operator.md` mirror) drop the interim restack-escalation wording | Those strings describe B0, which this change deletes; leaving them would document removed behaviour | S:70 R:90 A:85 D:85 |
| 10 | Confident | Ancestry is read via the GitHub compare API in observe (not a local fetch) | Keeps observe free of local git mutation, but `git fetch` + `merge-base --is-ancestor` is equally valid; plan may choose either | S:45 R:70 A:55 D:40 |
| 11 | Confident | `rebase --onto` upstream = predecessor PR's `headRefOid` (fetchable as `refs/pull/<n>/head`), falling back to `origin/<pred-branch>` | The reference used the predecessor branch, which GitHub may auto-delete after merge; PR head SHA survives deletion | S:40 R:70 A:60 D:45 |
| 12 | Confident | A `stale-base` PR with no merged in-sequence predecessor gets an escalate-once row (not a silent wait) and is never merged | Rule 6 needs an outcome; a stacked PR on a non-default base must not merge; plan's B1 guard covers only the predecessor case | S:35 R:75 A:55 D:45 |
| 13 | Confident | Stacked `failed`/`conflicting` PRs keep today's declared wait (no escalation) until R6c's rows land | Widening P5 to stacked would collide with R6c deleting P5; cost is a silent wait in the interim between R6b and R6c merging | S:40 R:80 A:55 D:50 |

13 assumptions (6 certain, 7 confident, 0 tentative, 0 unresolved).
