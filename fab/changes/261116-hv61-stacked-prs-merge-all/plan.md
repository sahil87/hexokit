# Plan: Stacked-PRs Merge-All (R6b)

**Change**: 261116-hv61-stacked-prs-merge-all
**Intake**: `intake.md`

Binding design source: `fab/plans/sahil/26-11-16-operator-autopilot-restructure.md` (§ Decisions,
§ Engine model, § Rules, § Briefs → R6b). Code lives in `app/backend/internal/autopilot/` unless
noted. Reference branch (read-only, never merged or cherry-picked):
`git fetch origin 261114-8w1x-r6-full-reference && git show "origin/261114-8w1x-r6-full-reference:<path>"`
(in zsh write `"${R}:<path>"`, never `"$R:<path>"` — `:a…` is a modifier even inside quotes).

## Requirements

### Autopilot: stacked-prs status derivation

#### R1: Derived status `stale-base`
`PRStatus` SHALL gain `PRStaleBase = "stale-base"`, placed in the PR precedence after `blocked`
and before `draft`:
`merged › paused › halted › closed › deferred › blocked › stale-base › draft › failed › conflicting › green › waiting`.
A PR item SHALL derive `stale-base` only when its mode is `stacked-prs` and, with its stale-base
facts read this pass, **either** its `baseRefName` is not the repo's default branch **or** it has
an in-sequence predecessor whose merge commit is not an ancestor of its `headRefOid`. The
in-sequence predecessor is the `depends_on` entry that is a PR item with the same `merge_seq`
(cross-repo barrier entries are not predecessors). A non-stacked PR SHALL never derive
`stale-base`. `allPRStatuses` and the `derivePR`/`prPrecheck` doc comments SHALL list it.

- **GIVEN** a stacked PR item whose predecessor PR item is recorded merged and whose base is `s1-branch`
- **WHEN** a pass derives its status
- **THEN** it is `stale-base`
- **AND** a stacked PR with base = default and the predecessor's merge commit an ancestor of its head is not `stale-base` (it falls through to draft/failed/conflicting/green/waiting)

#### R2: Unknown stale-base facts never derive `green`
For a stacked PR that reaches the stale-base check, if any stale-base fact could not be read this
pass (the head view, the default branch, the predecessor's merge commit, or the ancestry), the
PR SHALL derive `waiting` (never `stale-base`, `draft`, `failed`, `conflicting` or `green`). A
stacked PR SHALL derive `green` only when this pass positively established base == default and,
when it has an in-sequence predecessor, ancestry true.

- **GIVEN** a stacked head whose predecessor's `gh pr view --json mergeCommit` fails
- **WHEN** a pass runs
- **THEN** the PR derives `waiting`, the read failure escalates (deduped by text), and P7 does not fire

#### R3: Observe reads the stale-base facts for stacked heads only
`prViewFields` SHALL add `baseRefName` (and `prView` a `BaseRefName` field). For a `stacked-prs`
sequence head that `observePR` reads and that is not settled by the statuses before
`stale-base` (merged/paused/halted/closed/deferred/blocked), observe SHALL, before evaluating the
draft/check statuses:
1. resolve the repo's default branch (`e.defaultBranch`, cached per repo per pass);
2. when an in-sequence predecessor exists, read its merge commit once:
   `gh pr view <pred-n> --repo <nwo> --json mergeCommit` (`{"mergeCommit":{"oid":"…"}}`; a
   null/empty oid is an unreadable fact);
3. when base == default and a predecessor merge commit is known, read ancestry through the
   GitHub compare API: `gh api repos/<nwo>/compare/<mergeOid>...<headRefOid> --jq .status`;
   `ahead` or `identical` ⇒ ancestor, `behind` or `diverged` ⇒ not an ancestor, anything else ⇒
   unreadable.
A stale-base head SHALL NOT read checks. Non-stacked PRs SHALL NOT pay these reads. Reads SHALL
also run in the read-only `status` view (they are read-only GitHub calls). Each failed read SHALL
escalate through `e.escalate` with a specific prefix (`predecessor merge commit lookup failed: …`,
`ancestry lookup failed: …`).

- **GIVEN** a cherry-pick-ladder sequence head
- **WHEN** a pass observes it
- **THEN** no `mergeCommit` view and no `gh api …/compare/…` call is made

### Autopilot: stacked-prs rules

#### R4: Row B1 restacks; interim B0 is removed
The action vocabulary SHALL gain `ActionRestack = "restack"`. Row **B1** SHALL match
`PR · stale-base` with guard "has an in-sequence predecessor that is merged" (stored `done_at`
or observed `MERGED`), action `restack`, positioned after P3 and before P4. Row **B0**
(`restackGuard`, `restackText`, the `restack needed: PR #<n>` escalation) SHALL be deleted;
dedupe keys it wrote stay on disk unread.

- **GIVEN** a stacked PR `stale-base` whose predecessor is recorded merged
- **WHEN** `decide` runs
- **THEN** the decision is row `B1`, action `restack`, and no `restack needed` escalation is ever produced

#### R5: Stale base without a predecessor escalates once and never merges
Row **B2** SHALL match `PR · stale-base` with guard "no merged in-sequence predecessor, not yet
escalated for this reason", action `escalate`, reason
`stacked PR #<n> is based on <base>, not <default>, with no merged predecessor to restack from`
(escalate-once via the `escalated` dedupe key). After the escalation the combination SHALL be a
declared wait (`stale-base`: "already escalated: no predecessor to restack from"). Such a PR is
never readied, armed or merged while its base is not the default branch.

- **GIVEN** the first PR of a stacked sequence whose base is `feature-x`, not `main`
- **WHEN** two passes run
- **THEN** the first escalates once (B2), the second waits; no `gh pr merge` and no `gh pr edit` is issued

#### R6: P4 and P7 cover stacked PRs; P6 never does
P4 (`ready`) SHALL drop its `!stacked` guard (unconditional for `draft`). P7 (`merge`) SHALL drop
`!stacked` from `mergeGuard` (still: not armed, head commit observed; `--squash
--match-head-commit <observed head>`). P6 (`arm`) SHALL keep `!stacked`. The wait table SHALL
remove `{PR, draft, "stacked-prs: merged by R6b"}` and give every reachable (PR, mode, status)
a row or a truthful declared wait — including `stale-base` and stacked `waiting` (checks
pending, or "stacked-prs is never armed"). Stacked `failed`/`conflicting` keep their current
outcome (P5 is guarded `!stacked` ⇒ declared wait) — R6c owns them.

- **GIVEN** a stacked green PR (base = default, ancestry true, checks SUCCESS, MERGEABLE, unarmed)
- **WHEN** `decide` runs
- **THEN** P7 fires; a stacked `waiting` PR never matches P6; a stacked draft matches P4

#### R7: Decide table covers every reachable combination (rule 6)
The `decide` table test SHALL enumerate every reachable (item kind, merge mode, status) —
`stale-base` included, for all three modes (`stale-base` is unreachable for non-stacked modes,
which the enumeration SHALL assert by derivation, not by omission) — and assert the row that
fires or an explicit wait; no combination reports `unmatched`. The row-order assertion SHALL read
`… "P1", "P2", "P3", "B1", "B2", "P4", "P5", "P5", "P6", "P7"`.

- **GIVEN** the enumerating table test
- **WHEN** it runs
- **THEN** every (kind, mode, status) has a row or a declared wait

### Autopilot: the `restack` executor

#### R8: Restack retargets, rebases from `origin/<branch>` and force-pushes with an explicit lease
A new file `restack.go` SHALL implement the `restack` executor, ported from the reference
branch's `prepareStacked` (`merge.go` ≈685–771), `retarget` (`idempotent.go` ≈41–58) and
`conflictFiles` (`merge.go` ≈774), minus the claim code and the `prepared` marker. In order:
1. `reread(d)`; skip on change/vanish (existing escalation).
2. `checkedBranch` for the head branch and the predecessor branch.
3. If the PR is observed armed, disarm it first (`e.disarm`); a failed disarm escalates and stops.
4. `git fetch origin` in the repo; failure escalates and stops.
5. Default branch via `e.defaultBranch`.
6. Verify `origin/<branch>` resolves to the **observed** `headRefOid`; if not, escalate
   `PR #<n> head moved since observe; restack retried next pass` and stop. (Before any GitHub
   mutation, so a stopped restack leaves the PR untouched.)
7. Resolve `<upstream>` — the newest commit of the head's history that is **not** the PR's own
   work (see R12) — from the predecessor PR's `headRefOid` (`gh pr view <pred-n> --repo <nwo>
   --json headRefOid`); when the predecessor head object is not present locally after the
   fetch, escalate `cannot find predecessor head <sha> for PR #<n>` and stop (no halt).
8. If observed `baseRefName` ≠ default: `gh pr edit <n> --repo <nwo> --base <default>` with the
   reference's postcondition check (on "already"/"base branch was not changed", re-read
   `baseRefName` and accept only when it equals default); failure escalates and stops. Record
   `ActRetargeted` (`PR #<n> → <default>`).
9. Create a temporary detached worktree at the **observed head SHA** (`git worktree add --detach
   <tmp> <observed headRefOid>`, `<tmp>` under `os.MkdirTemp`; step 6 proved it equals
   `origin/<branch>`); never check out or modify a local `<branch>`.
10. `git rebase --onto origin/<default> <upstream>` inside it.
11. Verify the predecessor's merge commit (the observed `predMerge`) is an ancestor of the rebased
    `HEAD` (`git merge-base --is-ancestor`); if not (e.g. the predecessor was merged into a
    non-default base by hand), escalate `predecessor merge commit <sha> is not on <default>;
    PR #<n> not pushed` and stop without pushing (no halt), so B1 never churns force-pushes.
12. Push: `git push --force-with-lease=refs/heads/<branch>:<observed headRefOid> origin HEAD:refs/heads/<branch>`;
    failure escalates `push after rebase failed: …` and stops (no halt).
13. Record `ActRebased` (`<branch> onto <default>`).
14. Always remove the temporary worktree (`git worktree remove --force <tmp>`, then `git worktree
    prune`) on a context detached from the pass's cancellation
    (`context.WithoutCancel(ctx)` plus its own short timeout), so a cancelled pass still cleans up;
    a cleanup failure escalates.
Every subprocess goes through the existing `e.git`/`e.gh` helpers (exec with context and
timeout). `--dry-run` executes nothing (existing `execute` behaviour) and lists `restack (B1)`.

- **GIVEN** two stacked PRs where PR1 squash-merged and PR2 still targets `s1-branch`
- **WHEN** a pass runs B1
- **THEN** PR2's base becomes `main`, `origin/s2-branch` is rebased so `origin/main..origin/s2-branch` holds exactly PR2's own commits, and PR2 is not merged in that pass

#### R9: Restack is idempotent and writes no engine key
Restack SHALL write no intent marker and add no engine-file key. A crash after the retarget
re-derives `stale-base` (ancestry false) and B1 repeats with the retarget a no-op; a failure
between rebase and push repeats cleanly from `origin/<branch>`; after a successful push the
ancestry holds, B1's status no longer derives, and the restack never repeats. A local `<branch>`
that diverges from the remote SHALL NOT influence the result.

- **GIVEN** a restack whose push fails once
- **WHEN** the next pass runs
- **THEN** B1 fires again, rebases from `origin/<branch>`, pushes, and the following pass derives non-`stale-base`

#### R10: A rebase conflict halts and escalates, never skips
On rebase failure the executor SHALL collect the conflict files, run `git rebase --abort`
(escalate if the abort fails), write `halted` on this one item through `e.guarded(d.Item, d.fp,
…)`, and escalate `halted: rebase of <branch> onto <default> failed: <files> (cleanup attempted,
not skipped): <stderr>`. The halt cone is derived from that one write; the PR and every
downstream PR are never merged while halted. It SHALL NOT change the shared `halt` executor.

- **GIVEN** PR2 edits `shared.txt` and main's squash also changed `shared.txt`
- **WHEN** B1 runs
- **THEN** PR2 is `halted`, the escalation names `shared.txt` and says `not skipped`, and no merge is issued

#### R12: The rebase upstream survives the predecessor's own restack and never drops own work
`<upstream>` SHALL drop every commit the stacked branch inherited from its predecessors, for
every position in a chain of any length, and SHALL NEVER drop a commit whose change is not
already on the default branch:
1. `mb = git merge-base <predHead> <head>`.
2. Candidates, in order: every commit `git cherry <predHead> <head> <mb>` marks `-` (patch-equivalent
   to a commit in `<head>..<predHead>`), **newest first**, then `mb` itself. (When a predecessor
   was restacked before it merged, its merged head holds rebased copies; the successor's history
   holds the originals, which `git cherry` marks `-`.)
3. `<upstream>` = the first candidate `c` whose **drop is a no-op on the default branch**:
   `git merge-tree --write-tree origin/<default> <c>` exits 0 and its first output line (the
   result tree) equals `git rev-parse origin/<default>^{tree}` — i.e. everything reachable from
   `c` that the rebase discards is already contained in `origin/<default>`. (Automatic merge
   base, git ≥ 2.38; no `--merge-base`, which needs 2.40.) A candidate whose check fails or errors
   is skipped; `mb` is the final fallback.
A first restack uses the predecessor head itself; a third-or-later PR drops its predecessors'
original commits; a successor that cherry-picked a predecessor fix *after* its own commits keeps
its own commits (the newest `-` candidate fails the no-op check because its ancestry includes
own work, so an older candidate or `mb` wins and the duplicate fix replays as an empty commit).
If no candidate but `mb` qualifies and the replay conflicts, R10 halts — never a wrong merge.

- **GIVEN** a three-PR stack where PR1 has two commits editing the same line, PR1 squash-merges, PR2 is restacked and squash-merges
- **WHEN** B1 restacks PR3
- **THEN** the rebase succeeds and `origin/main..origin/s3-branch` holds exactly PR3's own commit; PR3 later merges
- **GIVEN** s1 = `P1a, P1fix`; s2 cut at `P1a` with `P2own` then a cherry-pick of `P1fix`; PR1 squash-merges
- **WHEN** B1 restacks PR2
- **THEN** `origin/main..origin/s2-branch` still contains `P2own`'s change (never an empty or own-work-less branch)
- **GIVEN** a three-PR stack whose PR3 = `X`, cherry-pick of `B1fix`, `Z` on top of PR2's original `B1`
- **WHEN** PR1 and PR2 have merged and B1 restacks PR3
- **THEN** PR3 keeps `X` and `Z`

#### R13: Default branch and stale-base reads are proven, not guessed
For stale-base derivation, the default branch SHALL count as known only when it came from a
verified `origin/HEAD` or a non-empty `gh repo view` answer — not from the `origin/main`/`master`
existence guess (the guess stays usable for spawn as today). An unknown default branch, or an
empty observed `baseRefName`, SHALL derive `waiting` **and escalate** (deduped by text) instead
of waiting silently.

- **GIVEN** a stacked head whose repo has no usable `origin/HEAD` and whose `gh repo view` fails, while `origin/main` exists
- **WHEN** a pass observes it
- **THEN** it derives `waiting`, escalates, and B1 does not fire

#### R14: After R6c, recovery covers stacked PRs past `stale-base`
Rebased onto R6c (#1142). R6c's C1–C4 already apply in every mode. C5/C6 (`conflicting` ⇒ one
`rebase` round onto the default branch, then halt) SHALL also apply to `stacked-prs`: a stacked PR
only reaches `conflicting` after `stale-base` no longer derives (base = default, the predecessor's
squash commit in its history), so R6c's `rebaseRecovery` (`git rebase origin/<default>` from
`origin/<branch>`, explicit-SHA lease) is exactly right for it, and B1 never fires for it. The
declared wait `conflicting: "stacked-prs: rebase is R6b's restack"` is removed (C5/C6 together
cover every `conflicting` PR). The merged precedence is
`… › blocked › stale-base › draft › fixing › failed › conflicting › green › waiting`, and the row order
`… P3, B1, B2, P4, C1, C2, C3, C4, C5, C6, P6, P7, F1, F2`. The duplicate `conflictFiles` is
dropped in favour of R6c's; `ActRebased` is shared.

- **GIVEN** a restacked stacked PR (base = default, ancestry true) that turns `CONFLICTING` for three polls
- **WHEN** `decide` runs
- **THEN** C5 fires (`rebase`), and after a spent round C6 halts — never a silent wait

### CLI and chat text

#### R11: Help and skill text describe the real stacked behaviour
`cmd/rk/operator_autopilot.go` SHALL replace "register chains with merge; restacks escalate until
supported" and the `merge` long help's "escalate restacks; they are never armed or merged in this
step" with the real behaviour: stacked PRs are readied, restacked after their predecessor merges
(retarget, `rebase --onto`, `--force-with-lease`), merged directly once green on the restacked
head, never armed; a rebase conflict halts and escalates. `app/backend/cmd/rk/skill/operator.md`
and its byte-identical mirror `docs/site/skill/operator.md` SHALL drop the `restack needed`
wording (lines ≈130–132) while keeping "never perform mechanical work from chat". `merge.go`'s
`StartMerge` doc comment SHALL drop the B0 sentence.

- **GIVEN** `rk operator autopilot merge --help`
- **WHEN** read
- **THEN** it mentions no restack escalation and describes the restack and direct merge

### Non-Goals

- **Review bar** (plan § Decisions, quoted): *"**Must-fix**: anything that can merge, arm, push,
  force-push or delete the wrong thing; lose or corrupt state-file data; launch a duplicate agent
  *under the single-writer rule*; crash the CLI; or break a requirement in the step's plan.
  **Should-fix** (does not block): failure cases the pass lock rules out, tmux pane-id reuse,
  missing escalations for read-only probes, and cosmetics. From R6r-ii, a finding that needs an
  external write to the engine file (a hand edit) is out of scope."*
- **Rule 6** (quoted): *"From R6r-i on, autopilot behaviour is added only as a status case, a rule
  row and an executor. A `decide` table test enumerates every reachable (item kind, merge mode,
  status) and asserts the row that fires, or an explicit `wait`. A behaviour outside the table,
  or a reachable combination with no outcome, is must-fix."*
- **Rule 7** (quoted): *"From R6r-ii on, the engine file is written only under the pass lock. A
  step never adds an engine key to a ledger item, and never reads a ledger item's `scope` for a
  decision beyond the projection keys listed in § Engine state file."*
- PR recovery (C1–C6, F1, removing P5, `fix-request`/`recovery-spawn`/`rebase`/`untrack`) — R6c
  (merged as #1142 while this change was in review; see R14 for the one guard R6b widens). Originally, R6b does not touch P5, `stallGuard`/`stallText`, the failed/conflicting waits or the
  `halt` executor.
- Claim machinery, CAS snapshots, overlapping-pass handling; the `prepared` marker; any new
  engine-file key.
- Arming stacked PRs; brief changes; dependency-branch drift after a dependent PR exists.

### Design Decisions

#### Ancestry through the GitHub compare API
**Decision**: Observe reads "predecessor merge commit is an ancestor of the head" with `gh api repos/<nwo>/compare/<merge>...<head> --jq .status`.
**Why**: Observe stays free of local git mutation (no fetch per pass), works in the read-only status view, and both commits are guaranteed to exist on GitHub.
**Rejected**: `git fetch` + `git merge-base --is-ancestor` in observe — mutates remote-tracking refs on every pass and needs network git in the read-only view.
*Introduced by*: 261116-hv61-stacked-prs-merge-all

#### Restack in a detached temporary worktree with an explicit-SHA lease
**Decision**: The rebase runs in `git worktree add --detach <tmp> <observed head SHA>` (verified equal to `origin/<branch>`) and pushes `HEAD:refs/heads/<branch>` with `--force-with-lease=refs/heads/<branch>:<observed head>`.
**Why**: The authoring agent's worktree has `<branch>` checked out and must not be touched; starting from the remote makes a crash repeat cleanly; the explicit lease turns a concurrent agent push into a failed push instead of an overwrite (force-pushing the wrong thing is must-fix).
**Rejected**: The reference's `worktreeFor` (reuses the agent's worktree or spawns one through the spawner and records it under a claim); a bare `--force-with-lease` (lease against whatever the local tracking ref says).
*Introduced by*: 261116-hv61-stacked-prs-merge-all

#### Rebase upstream from patch equivalence, gated by a no-op drop check
**Decision**: `<upstream>` = the newest `git cherry predHead head mb` `-` commit (else `mb`) whose drop is a no-op on the default branch: `git merge-tree --write-tree origin/<default> <c>` yields `origin/<default>^{tree}`.
**Why**: GitHub may delete the merged predecessor branch, and a restacked predecessor's merged head is a rebased copy that is not in the successor's history; patch equivalence finds the inherited-commit boundary at every chain position without storing a key, and the tree check proves no own work is discarded (a cherry-picked predecessor fix can sit after own commits).
**Rejected**: `merge-base(predHead, head)` alone — replays predecessors' originals from the third PR on (spurious conflict halts). The newest `-` commit alone — silently drops own commits that precede a cherry-picked fix, then force-pushes and merges the wrong thing. Storing each PR's pre-restack head — a new engine key, forbidden. Cascading the restack into descendants — acts on items other than the decided one. `merge-tree --merge-base` — needs git 2.40.
*Introduced by*: 261116-hv61-stacked-prs-merge-all

#### Stacked restack is a derived status, not a marker
**Decision**: B1 fires on `stale-base`, derived each pass from base and ancestry; no `prepared` key.
**Why**: Plan § Rule table consequence "Stacked restack needs no `prepared` key" — the guard turns false once the squash commit is an ancestor of the head, so the restack never repeats and a crash is re-derived.
**Rejected**: The reference's stored `prepared` marker (a stored non-monotone fact that can drift).
*Introduced by*: 261116-hv61-stacked-prs-merge-all

### Deprecated Requirements

#### Interim `restack needed` escalation (row B0)
**Reason**: R6b performs the restack.
**Migration**: Row B1 (`restack`) and B2 (no-predecessor escalation).

## Tasks

### Phase 1: Setup

- [x] T001 Add `BaseRefName string \`json:"baseRefName"\`` to `prView` (`gate.go`) and `baseRefName` to `prViewFields` (`observe.go`); add stale-base fact fields to `prFacts` in `status.go` (e.g. `stacked bool`, `staleRead bool` = all needed facts read, `base`, `defaultBranch`, `hasPred bool`, `predMerge string`, `ancestor bool`) <!-- R3 -->
- [x] T002 Extend the gh simulator in `harness_test.go`: `simPR.Base` (default `main`) returned as `baseRefName`; `pr edit <n> --base <b>` handler (counts calls, sets Base); `pr view … --json mergeCommit` returning `{"mergeCommit":{"oid":…}}` for merged PRs; `api repos/<nwo>/compare/<a>...<b> --jq .status` answered by real `git merge-base --is-ancestor` in the origin repo; an optional per-PR origin binding so `HeadOid` is read live from `refs/heads/<branch>` of the bare origin (so a force-push changes the observed head); an `onMerge` hook that lets a test land a squash commit on origin and records its SHA as the PR's merge commit. Keep every existing test's behaviour unchanged (opt-in fields) <!-- R1 -->

### Phase 2: Core Implementation

- [x] T003 `status.go`: add `PRStaleBase`, insert it into `allPRStatuses` and the precedence after `blocked`; in `prPrecheck`, after `blocked` and before the unread/draft cases, for a stacked item: facts not fully read ⇒ `PRWaiting`; base ≠ default or (has predecessor and !ancestor) ⇒ `PRStaleBase`; add an `inSeqPredecessor(st, it)` helper (the `depends_on` PR item with the same `merge_seq`); update doc comments <!-- R1, R2 -->
- [x] T004 `observe.go`: in `observePR`, for a stacked head not settled before stale-base, read default branch, predecessor merge commit (`gh pr view <pred-n> --repo <nwo> --json mergeCommit`) and ancestry (`gh api repos/<nwo>/compare/<merge>...<head> --jq .status`), set the T001 fields, escalate each failed read with its prefix, and skip the checks read when the head derives `stale-base`; never for non-stacked PRs; update the observe doc comment (predecessor is now read for stacked heads) <!-- R3, R2 -->
- [x] T005 `rules.go`: add `ActionRestack`; delete B0 (`restackGuard`, `restackText`, `upstreamMerged` if unused); add B1 (`stale-base`, predecessor merged ⇒ `restack`) and B2 (`stale-base`, no merged predecessor, not yet escalated ⇒ `escalate` with the R5 reason) after P3; drop `!stacked` from P4 and from `mergeGuard`; keep P6's; update `waitTable` (remove the stacked draft wait, add `stale-base` wait, make the stacked `waiting` reason truthful) <!-- R4, R5, R6 -->
- [x] T006 New `restack.go`: the `restack` executor per R8 steps 1–13 and the conflict path per R10 (port `retarget` and `conflictFiles` from the reference; the halt write uses `e.guarded`, then `e.escalate`, then disarm if armed); add `ActRetargeted = "retargeted"` and `ActRebased = "rebased"` in `autopilot.go`; dispatch `ActionRestack` in `execute.go` <!-- R8, R9, R10 -->

### Phase 3: Integration & Edge Cases

- [x] T007 `rules_test.go`: replace the B0 case with B1/B2 cases; update stacked expectations (draft ⇒ P4, green ⇒ P7, waiting ⇒ never P6 with its wait, failed/conflicting ⇒ declared wait); build stacked fixtures with stale-base facts read (base default, ancestry true) where the case is not about stale-base; add `stale-base` with/without merged predecessor and "facts unreadable ⇒ waiting, never P7"; update the row-order assertion; the enumeration covers `stale-base` for every mode <!-- R4, R5, R6, R7, R2 -->
- [x] T008 [P] `status_test.go`: derivation cases — stacked base ≠ default ⇒ `stale-base`; base default + ancestry false ⇒ `stale-base`; base default + ancestry true ⇒ falls through; unreadable predecessor merge commit / compare ⇒ `waiting`; non-stacked never `stale-base`; precedence (halted/blocked/deferred beat `stale-base`, `stale-base` beats `draft`) <!-- R1, R2 -->
- [x] T009 New `restack_test.go` (real temp repos + scripted gh): port `TestStackedMergesStepByStepRetargetsAndRebases`, `TestStackedKeepsAnExistingRetargetUntouched`, `TestStackedRebaseConflictHaltsNeverSkips`, `TestStackedNeverMergesInThePassThatMutatedThePR`, `TestStackedReadiesADraftBeforeMerging` (minus claim/`prepared` asserts; one action per item per pass, so assert across passes); add: no `gh pr merge --auto` ever on a stacked PR; restack ignores a diverged local `<branch>`; the lease refuses when origin moved after observe (no overwrite, escalation, no halt); push failure then success on the next pass; predecessor branch deleted on origin still restacks; restack never repeats once ancestry holds (`gh pr edit` ≤ 1, rebases = 1); armed stacked PR is disarmed before the retarget; no-predecessor stale base escalates once and never merges; `--dry-run` lists `restack (B1)` and changes nothing; the temporary worktree is removed on success and on conflict; a cherry-pick-ladder sequence makes no `mergeCommit`/compare reads <!-- R8, R9, R10, R5, R3 -->
- [x] T010 [P] CLI/chat text per R11: `cmd/rk/operator_autopilot.go` mode list + `merge` long help; `app/backend/cmd/rk/skill/operator.md` and `docs/site/skill/operator.md` (keep byte-identical); `merge.go` `StartMerge` comment; update any `cmd/rk` test asserting the old strings <!-- R11 -->

### Phase 4: Polish

- [x] T011 Run the gates: `cd app/backend && go vet ./internal/autopilot/ ./cmd/rk/`, `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`, `go test ./cmd/rk/ -count=1`, then `just test-backend` (known host-only failures `TestPortPinRowRealPolicyValues` and `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath` do not block); fix what fails <!-- R7 -->

### Phase 5: Rework (review 1)

- [x] T012 `restack.go` `restackUpstream`: implement R12 (merge-base, then `git cherry <predHead> <head> <mb>`, newest `-` commit else `mb`) via `e.git`; keep the missing-object escalation <!-- R12 -->
- [x] T013 `restack.go`: reorder per revised R8 — head-moved check (step 6) and upstream (step 7) before the retarget (step 8); worktree added at the observed head SHA (step 9); after the rebase, `git merge-base --is-ancestor <predMerge> HEAD` gate before the push (step 11, escalate, no push, no halt); cleanup on `context.WithoutCancel(ctx)` with its own short timeout (step 14) <!-- R8 -->
- [x] T014 `repo.go` / `observe.go`: track whether the default branch is proven (origin/HEAD or gh) vs guessed; stale-base treats a guessed or unknown default, or an empty `baseRefName`, as unreadable ⇒ `waiting` plus an escalation (R13); spawn behaviour unchanged <!-- R13 -->
- [x] T015 `restack_test.go`: add a 3-PR step-by-step test whose PR1 has two commits touching the same hunk (squash each merge on origin via the sim) — PR3 restacks cleanly, carries only its own commit, and merges; add a test that a predecessor merge commit missing from the default branch escalates and pushes nothing; rename or extend `TestRestackConflictDoesNotSkipDownstream` with a third PR that stays unmerged through the halted cone; add a guessed-default test for R13; extend the sim if needed <!-- R12, R8, R10, R13 -->
- [x] T016 [P] `rules_test.go:~392`: fix the stale case name "a stacked-prs PR waits" on the P7 green case (stacked green now fires P7) <!-- R6 -->
- [x] T017 Re-run the gates of T011 <!-- R7 -->

### Phase 6: Rework (review 2)

- [x] T018 `restack.go` `restackUpstream`: implement the revised R12 — candidates = `git cherry <predHead> <head> <mb>` `-` commits newest first, then `mb`; pick the first whose `git merge-tree --write-tree origin/<default> <c>` exits 0 with first line == `git rev-parse origin/<default>^{tree}`; all via `e.git` <!-- R12 -->
- [x] T019 `restack.go` rebase-failure path: when the rebase fails and `ctx.Err() != nil` (cancelled or timed-out pass), abort the rebase on the detached cleanup context and escalate (`restack of PR #<n> interrupted: …; retried next pass`) instead of halting; only a genuine rebase failure halts (R10) <!-- R10 -->
- [x] T020 [P] `restack.go` `rebasedContainsPredecessor`: distinguish exit 1 (not an ancestor ⇒ the existing escalation) from other errors (`exitCode(err, 1)`; other errors escalate `predecessor ancestry check failed: …`), no push either way <!-- R8 -->
- [x] T021 `restack_test.go`: 2-PR test with a cherry-picked predecessor fix after the successor's own commit (own commit survives the restack and PR2 later merges with it); 3-PR test `X, cherry-pick(B1fix), Z` keeps `X` and `Z`; extend `TestRestackCleanupSurvivesPassCancellation` (or add a test) asserting a cancelled pass does NOT write `halted` and escalates; keep the existing 3-PR test green <!-- R12, R10 -->
- [x] T022 Re-run the gates of T011 <!-- R7 -->

### Phase 7: Rebase onto R6c

- [x] T023 Rebase onto `origin/main` (R6c #1142): resolve `rules.go`/`status.go`/`autopilot.go`/`execute.go`/`cmd/rk` and test conflicts per R14 (precedence, row order, action and act constants, waits), drop `!stacked` from C5/C6 and the stacked conflicting wait, remove the duplicate `conflictFiles`, update the C5/C6 table cases; gates green (autopilot race suite; `cmd/rk` only the host-only `TestPortPinRowRealPolicyValues`) <!-- R14 -->

## Execution Order

- T001 and T002 first; T003 → T004 → T005 → T006 (each consumes the previous); T007–T010 after Phase 2; T011 last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `PRStaleBase` exists, sits after `blocked` and before `draft` in `allPRStatuses` and derivation, and only stacked PRs derive it
- [x] A-002 R3: `prViewFields` includes `baseRefName`; stacked heads read the predecessor merge commit and the compare status; non-stacked PRs make neither call
- [x] A-003 R4: Row B1 (`stale-base`, predecessor merged ⇒ `restack`) exists after P3; B0 and `restack needed` are gone from code
- [x] A-004 R5: Row B2 escalates once for a stacked `stale-base` with no merged predecessor and the PR is never merged or retargeted
- [x] A-005 R6: P4 readies stacked drafts, P7 merges stacked green PRs with `--match-head-commit`, P6 never arms a stacked PR
- [ ] A-006 R8: `restack.go` verifies the observed head, resolves the upstream per R12 and only then retargets (verify-or-perform), rebases in a detached temporary worktree at the observed head SHA with `--onto origin/<default> <upstream>`, gates the push on the predecessor merge commit being an ancestor, pushes with `--force-with-lease=refs/heads/<branch>:<observed head>`, and removes the worktree
- [x] A-007 R11: Help text, chat skill and its mirror no longer describe a restack escalation

### Behavioral Correctness

- [x] A-008 R2: A stacked PR with any unreadable stale-base fact derives `waiting` and is never merged in that pass
- [x] A-009 R6: A stacked sequence merges PR1, restacks PR2 on the next pass, and merges PR2 only on a later pass once green on the restacked head
- [x] A-010 R9: Restack writes no engine-file key and no `prepared` marker; after a successful push it never fires again

### Removal Verification

- [x] A-011 R4: No reference to `restackGuard`, `restackText`, `restack needed` or the "stacked-prs: merged by R6b" wait remains in `internal/autopilot`, `cmd/rk` or the skill docs

### Scenario Coverage

- [x] A-012 R7: The `decide` table test enumerates every (kind, mode, status) including `stale-base` with no `unmatched`, and the row-order assertion includes B1, B2
- [x] A-013 R8: Ported stacked executor tests pass against real temp repos (retarget, existing retarget untouched, never merge in the mutating pass, ready a draft)
- [x] A-014 R10: A rebase conflict test asserts `halted`, conflict file named, `not skipped`, no merge, worktree removed

### Edge Cases & Error Handling

- [x] A-015 R9: Tests cover a diverged local branch, a lease refusal after origin moved, a push failure retried next pass, and a deleted predecessor branch
- [x] A-016 R8: An armed stacked PR is disarmed before retarget; a failed disarm stops the restack with an escalation
- [x] A-017 R3: Failed predecessor/compare reads escalate with their prefixes and do not block other items

### Rework (review 1)

- [x] A-024 R12: A three-PR stack (PR1 with two same-hunk commits) restacks PR3 without conflict, PR3 carries only its own commit, and all three merge in order
- [x] A-025 R8: The retarget runs only after the head-moved check and upstream resolution; the worktree starts at the observed head SHA; no push happens when the predecessor merge commit is not an ancestor of the rebased HEAD; cleanup uses a non-cancelled context
- [x] A-026 R13: A guessed or unknown default branch, or an empty baseRefName, derives waiting with an escalation and never triggers B1 or P7

### Rework (review 2)

- [ ] A-027 R12: A successor that cherry-picked a predecessor fix after its own commit keeps its own commit through the restack (2-PR and 3-PR tests); the upstream is chosen only when `merge-tree` proves the drop is a no-op on the default branch
- [ ] A-028 R10: A cancelled or timed-out pass during the rebase escalates and does not write `halted`

### Rebase onto R6c

- [ ] A-029 R14: C5/C6 fire for a stacked `conflicting` PR, the stacked conflicting wait is gone, the merged precedence and row order match R14, and only one `conflictFiles` exists

### Code Quality

- [x] A-018 Pattern consistency: new code follows the executor/rule shapes in `execute.go` and `rules.go` (reread → guarded writes → `e.escalate`), naming matches siblings
- [x] A-019 No unnecessary duplication: existing helpers (`e.git`, `e.gh`, `e.viewPR`, `e.pin`, `e.target`, `e.disarm`, `e.defaultBranch`, `checkedBranch`, `exitCode`, `alreadyApplied`, `withRepo`) are reused
- [x] A-020 Subprocess safety: every git/gh call goes through `exec.CommandContext` with argument slices and a timeout (via the runner); no shell strings
- [x] A-021 Comments state constraints only (no narration, no change IDs/PR numbers); functions stay focused (no >50-line god function without reason)
- [x] A-022 Tests accompany every changed behaviour; `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/` passes

### Security

- [x] A-023 R8: Branch names from state are validated with `checkedBranch`/`safeBranch` before any git argument; the temporary worktree path comes from `os.MkdirTemp`

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- Every review dispatch quotes the review bar and rules 6–7 (Non-Goals above).

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (`upstreamMerged`, `restackGuard`, `restackText` and the stacked draft wait were already removed in the diff; `stackedWaits` in `rules_test.go` is still used by the P5/P6 cases)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Ancestry via the GitHub compare API in observe | Intake #10 recommended it; observe stays mutation-free and works in the read-only status view | S:60 R:70 A:70 D:55 |
| 2 | Confident | Upstream = `git merge-base <predecessor headRefOid> <head>`; missing object escalates without halting | Predecessor head SHA is in the stacked branch's history after fetching it; survives branch deletion (intake #11) | S:55 R:70 A:70 D:55 |
| 3 | Confident | B2 escalate-once for stale base without a merged predecessor, then a declared wait | Rule 6 needs an outcome; merging into a non-default base is must-fix (intake #12) | S:55 R:80 A:70 D:60 |
| 4 | Confident | Restack disarms an observed-armed stacked PR before retargeting | An armed PR could fire on stale-green checks after GitHub's no-re-CI retarget (fab-operator §6); within B1's executor, no new row | S:55 R:80 A:75 D:60 |
| 5 | Confident | Restack verifies `origin/<branch>` equals the observed head before rebasing; mismatch escalates and retries next pass | Pairs with the explicit lease so a concurrent agent push is never rewritten from a stale base | S:60 R:80 A:75 D:65 |
| 6 | Confident | Stacked failed/conflicting keep the declared wait; P5 untouched | R6c deletes P5 in parallel (intake #13) | S:60 R:80 A:70 D:60 |
| 7 | Certain | Conflict path writes `halted` via `e.guarded` in `restack.go`, not via the shared `halt` executor | Keeps R6c's likely halt-reason generalisation conflict-free (intake #8) | S:75 R:85 A:85 D:80 |

7 assumptions (1 certain, 6 confident, 0 tentative).
