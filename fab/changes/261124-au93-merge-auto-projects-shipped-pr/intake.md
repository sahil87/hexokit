# Intake: merge-auto projects the shipped item's PR

**Change**: 261124-au93-merge-auto-projects-shipped-pr
**Created**: 2026-11-24

## Origin

> Execute step T11 (merge-auto projects the shipped item's PR) of the plan at
> /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first
> (Decisions and Rules bind you), then implement only the T11 Brief.

One-shot `/fab-new`, run by the operator queue (`ot-t11` worktree, queue mode `merge-auto`). The plan is read
from this worktree's checkout (`fab/plans/sahil/26-11-20-operator-triggers.md`, HEAD `990bfd88`); the copy in
the main checkout predates T11 and has no T11 brief. The plan's **Decisions already taken** table and **Rules
for the operator executing this plan** bind this change. The plan's posture is "no user involvement until the
end", so the design decisions below were taken from the brief, the plan's decisions, and the code — no
questions asked.

The T11 brief, verbatim:

> **Problem.** T3 deleted the PR rows and with them Q7 (`track-pr`), so nothing tracks a shipped item's PR.
> Under `merge-auto` that leaves two holes, both seen on `hexokit` on 11-23/24 with `ot-t8` → `ot-t9`:
> a queue item's `done` is not a judgment reason (`operatorloop/judgment.go`: only a `github-pr` item or
> an item with `then`) and a done item yields no `agent:idle` edge, so no run is launched to merge the
> green PR; and a PR merging is not an edge, so the successor's merged-PR barrier is never re-evaluated
> until some unrelated run happens (the chat had to force `autopilot step`). No merge-auto queue has
> merged a PR by itself under the new engine.
>
> - **Engine** (`internal/autopilot`): the Q1 `record-done` executor, for a `merge-auto` item whose
>   branch has a PR (`gh pr view <branch> --json number,url` — the read the barrier already does),
>   adds a `github-pr` ledger item `pr-<n>` through the projection path: `scope {repo, pr, change}`,
>   probe `gh pr view <n> --json state,mergedAt,mergeable,isDraft`, `check_every 5m`,
>   `done_when: state == "MERGED"`, `then: "merge-auto: ready and merge this PR when its required
>   checks are green"`; the existing `pr-<n>` collision rule applies; no PR yet ⇒ nothing projected and
>   the next pass retries (the item stays `done`). The engine never arms, readies or merges — it tracks.
>   `cherry-pick-ladder` and `stacked-prs` items project nothing (merges are on the user's word; the chat
>   tracks PRs when asked).
> - **Loop**: unchanged — a `changed` probe delta (checks, draft, mergeable) or `done` (MERGED) on a
>   `github-pr` item is already judgment; the run's Merging rules already say merge each green PR; the
>   MERGED run's mechanical pass sees the successor's barrier satisfied and spawns it.
> - **Brief**: the `then:` text is what the run reads; add one line to § Merging: a `pr-<n>` item carrying
>   `then: merge-auto …` is the PR to ready and merge when green, `gh pr merge --squash
>   --match-head-commit <observed-head-sha>`; red checks follow the fix-request rule.
> - Tests: `record-done` projects the item once (a second pass is idempotent); no PR ⇒ no item; the
>   judgment-set table gains the `pr-<n>` `changed`/`done` cases; a loop integration case: merge-auto
>   item done → PR item → MERGED → successor spawned on the next pass.
> - Docs: `operator-autopilot.md` (Q1, projection items, a Design Decision "merge-auto tracks, the run
>   merges"), `operator-loop.md` § judgment set, `operator-brief.md` § Merging.

## Why

**The problem.** Under the T3 engine (`internal/autopilot`, rows X0, X1, Q1–Q5) nothing tracks a shipped queue
item's PR. On a `merge-auto` queue that leaves two holes:

1. **No run is launched to merge the green PR.** When a queue item finishes, row Q1 (`record-done`) writes
   `done_at` on the engine item, and that is all. A `done` delta on a `pane` queue item is not a judgment reason
   (`app/backend/internal/operatorloop/judgment.go` `reasonNeedsJudgment`: `DeltaDone` is judgment only for
   `item.Kind == operator.KindGitHubPR` or an item with a non-empty `then`), and a done item yields no further
   `agent:idle` edge. So the mechanical pass ends `mechanical · 1 actions` and no model run ever sees the PR.
2. **A PR merging is not an edge.** The successor's merge-auto barrier (`gate.go` `depMerged`, read in
   `observeReadiness`) is only re-evaluated when some fire runs a pass. Nothing in the ledger changes when the
   predecessor's PR merges, so `operator.Check` reports `no change`, no pass runs, and the successor stays
   `held` until an unrelated edge happens. On 11-23/24 the chat had to force `rk operator autopilot step` to
   get `ot-t9` spawned after `ot-t8` merged.

Net: no merge-auto queue has merged a PR by itself under the new engine, which defeats the plan's
"PRs merge when green (`merge-auto`)" posture and the R2 roll-out that waits on T8–T12.

**If not fixed.** Every merge-auto queue stalls after its first item: a human (or the chat) must merge each PR
and then force a pass, i.e. the queue mode is decorative.

**Why this approach.** The plan's binding decision "PR work — Back to the AI" forbids the engine from readying,
arming or merging (T3 deleted those rows; Rule 7: do not keep PR executors "for later"). Tracking is not
acting: a `github-pr` ledger item is the existing, generic way to make a PR observable to `operator.Check`
(a probe with `done_when: state == "MERGED"`). Its first probe emits a `changed` delta (empty `last` → fields),
later field changes emit `changed`, and MERGED emits `done` — all already judgment for a `github-pr` item, and
any fire with changes runs the mechanical pass first, which re-evaluates the successor's barrier. So one
projected ledger item closes both holes with no change to the loop or the judgment code. Rejected
alternatives: restoring the old Q7/P-row PR sequence (contradicts the plan's PR-work decision); making a queue
item's `done` a judgment reason (fixes hole 1 only, and only once — a still-pending CI would leave the PR
untracked again, and hole 2 stays open); a per-PR `gh pr checks --watch` watcher (rejected by the plan's PR
trigger decision).

## What Changes

### 1. Engine: Q1 projects the PR of a done merge-auto item (`app/backend/internal/autopilot`)

**Row and guard.** Q1 stays the one row on status `done` that acts, and its executor `recordDone`
(`execute.go`) gains the projection. Because "no PR yet ⇒ nothing projected and the next pass retries (the
item stays `done`)", Q1 must be able to fire again after `done_at` is written. Q1's guard becomes:

```
Q1 | done | engine done_at unset  OR  (merge mode merge-auto AND the engine item's PR is not yet tracked) | record-done
```

(as code: `doneAtUnset(c) || needsPRTrack(c)` where `needsPRTrack` = `modeOf(c.it) == operator.MergeModeMergeAuto`
and the engine item carries no "PR tracked" marker.) The wait-table entry for `done` stays ("recorded;
nothing left to track") for every other done item. `decide` stays pure: the guard reads only the engine item.

**Executor.** `recordDone(d)`:

1. If `done_at` is unset, write it (as today) and emit `ActDone … completion observed`.
2. If the item is `merge-auto` and not yet PR-tracked, re-read it (`e.reread` / fingerprint guard, as other
   executors), resolve its branch with `itemBranch(st, it)` (the view's branch — `/fab-new` renames the
   spawn-time branch to the change name, so the engine's own `branch` can be stale), and read the PR with the
   same read the barrier does: `e.viewPR(ctx, repo, branch, "number,url,state")` (extend `prView` with
   `Number int`). `recordDone` gains a `ctx` parameter (the `execute` switch passes it).
   - **No PR found** (`noPRFound(err)`): do nothing more — no item, no marker, no escalation; the next pass
     retries (Q1 still matches).
   - **Other gh failure**: escalate once on the queue item (`escalate(id, "PR lookup failed: <stderr>")` via
     the existing escalation machinery) and leave the marker unset so a later pass retries.
   - **No branch recorded**: escalate (`cannot track PR: no branch recorded`), no marker.
   - **PR `MERGED` or `CLOSED`**: nothing to track — write the PR-tracked marker only (no ledger item). The
     barrier already reads MERGED directly, and the same pass already sees it.
   - **PR `OPEN`**: add the `github-pr` ledger item (below) and then write the marker.
3. Emit a result action, e.g. `e.act(ActPRTracked, qi.ID, "pr-<n>")` (new `Act…` constant beside `ActDone`),
   so `step`/the run record shows it.

**The ledger item.** Built with `operator.NewGitHubPRItem` (it validates the repo `owner/name`, builds the
`gh pr view <n> --repo <nwo>` probe and the `state == "MERGED"` default), then adjusted to the brief's values:

```yaml
id: pr-<n>                     # collision rule below
kind: github-pr
probe:
  mode: shell
  argv: [gh, pr, view, "<n>", --repo, "<owner/name>", --json, "state,mergedAt,mergeable,isDraft,mergeStateStatus"]
  fields: [state, mergedAt, mergeable, isDraft, mergeStateStatus]
check_every: 5m
done_when: state == "MERGED"
then: "merge-auto: ready and merge this PR when its required checks are green"
depends_on: []
scope:
  repo: <local repo path, same as the queue item's scope.repo>
  pr: <n>
  change: <the queue item's view change, may be empty>
  item: <queue item id>        # the source queue item; the run's merge authority (§ 3)
```

- `--repo <nwo>` is kept (as `NewGitHubPRItem` and `defaultGitHubPRArgv` already require: a shell probe runs
  from the caller's cwd, so without it the probe would query the wrong repo). `nwo` comes from the existing
  `operator` seam that resolves `gh repo view --json nameWithOwner` in the repo dir (export it, or an
  equivalent engine helper through `e.gh`, honoring `exec.CommandContext` + timeout). A failed `nwo`
  lookup is an escalation and no marker (retry next pass).
- `mergeStateStatus` is added to the brief's field list: the brief names "checks" as one of the `changed`
  deltas, but `state`/`mergeable`/`isDraft` do not change when required checks turn green, so without it a PR
  whose checks finish after the first probe would never re-trigger a run. `mergeStateStatus`
  (`BLOCKED`/`UNSTABLE` → `CLEAN`, `BEHIND`, `DIRTY`, `DRAFT`) is the one scalar that moves on exactly those
  transitions.
- `then` is set on the built item (`NewGitHubPRItem` takes no `then`).

**Projection path.** The item is written to the ledger under `operator.Mutate` in one locked write that also
re-checks (as the old `addPRItems` did) that the source queue item still exists in the engine view with the
decided fingerprint — a changed item is escalated `changedText` and skipped. Within that write:

- **Idempotence / dedupe**: if any ledger item of kind `github-pr` already has the same `scope.repo` (compared
  with `cleanRepo`/`samePath`) and the same `scope.pr`, add nothing (the user or chat already tracks it) — the
  marker is still written.
- **Collision rule** (the pre-T3 `newPRItem` rule, from git history `b2c625b7^:app/backend/internal/autopilot/`):
  id `pr-<n>`; if taken by a different item, `pr-<basename(repo)>-<n>`; if that is taken too, count up
  `pr-<basename(repo)>-<n>-2`, `-3`, … until free.

The existing `upsertProjection` builds pane items (`operator.NewPaneItem`, pane-only `projectionScope` keys,
`branch_map` writes, the engine `projected` flag) and is not reused as-is for a `github-pr` item; a small
sibling write (e.g. `addPRProjection`) holds the above. The `pr-<n>` item is **not** engine-owned:
`OwnedIDs` still returns queue ids only, so `track` verbs, `autopilot rm`'s refusal, `status` (queue items
only) and the judgment set treat it as an ordinary `github-pr` ledger item (already documented in
`operator-state.md` and `operator-autopilot.md`).

**Marker.** A new engine-file field on `engineItem`, e.g. `PRTracked string \`yaml:"pr_tracked,omitempty"\``
holding the projected item id, or the PR state (`merged`/`closed`/`tracked`) when nothing was projected —
written through the existing `guarded`/`mutateEngine` path after the ledger write succeeds (durable before
the pass reports it — Constitution II). It is intent/history, not a non-monotone fact (the PR state is never
read back from it). Old files load without it (tolerant read); an older binary reading a newer file ignores
the unknown key and the next locked write drops it (the documented tolerant-read rule). A user `track rm` of
the projected `pr-<n>` item is never re-added (the marker is set) — same "projection removal is a fact"
stance as X0.

**Scope by mode.** Only `merge-auto` items project. `cherry-pick-ladder` and `stacked-prs` items record done
exactly as today and project nothing (merges there are on the user's word; the chat tracks PRs when asked).
Items done before this change ships (engine `done_at` set, no marker) on a merge-auto queue are picked up on
the next pass by the widened guard — an OPEN PR gets its item, a MERGED one only the marker.

**Engine never acts on the PR.** No `gh pr ready|merge|edit` from the engine; the only gh calls added are
`gh pr view` (read) and the `nameWithOwner` read.

### 2. Loop (`app/backend/internal/operatorloop`) — no code change

`reasonNeedsJudgment` already returns true for `DeltaChanged` and `DeltaDone` on a `KindGitHubPR` item. The
sequence on a merge-auto queue becomes:

1. Fire N: check sees the queue item complete → run-exec → mechanical pass: Q1 writes `done_at` and projects
   `pr-<n>` → judgment set empty (a queue item's done is mechanical) → `mechanical · 1 actions`.
2. Fire N+1: check probes `pr-<n>` for the first time (`checked_at` null ⇒ due; empty `last` ⇒ `changed`) →
   judgment → a run reads the item (`then:` merge-auto …) and merges it if green, else leaves it.
3. Later field changes (`isDraft`, `mergeStateStatus`, `mergeable`) → `changed` → judgment again.
4. PR MERGED → `done` delta on `pr-<n>` → run-exec's mechanical pass sees the successor's `depMerged`
   barrier satisfied and spawns it (Q2) on that same fire.

Only tests are added here (§ 5).

### 3. Brief (`app/backend/internal/operator/brief_rules.md` § Merging)

Add one line to § Merging (in the `merge-auto` bullet or directly after it):

> A `pr-<n>` item carrying `then: merge-auto …` was projected by the engine for a shipped merge-auto queue
> item (`scope.item`): it is the PR to ready and merge when green — `gh pr ready <n>` if draft, then
> `gh pr merge <n> --squash --match-head-commit <observed-head-sha>`; red checks follow the fix-request rule.

Authority: the confirmation-tiers paragraph says "A `github-pr` item that is not a queue item has no mode: it
needs a `by: user`/`by: chat` note." The added line must make the merge authority explicit and anchored to
the engine, not to editable text: the projected item's authority is its source queue item's mode
(`scope.item` → `merge_mode: merge-auto` in `rk operator autopilot status -L <server> --json`); `then` text
alone (which anyone can write with `track add --then`) is not authority. Adjust the tiers sentence to
reference this exception. The render/golden tests that pin `brief_rules.md` content are updated.

### 4. Chat skill

No change required by the brief. If `docs/site/skill/operator.md` describes what the engine projects or "who
tracks a merge-auto PR", align that sentence and run the sync to `cmd/rk/skill/operator.md` (drift guard).

### 5. Tests

- `internal/autopilot`:
  - `record-done` on a merge-auto item with an OPEN PR projects `pr-<n>` with the scope/probe/then/check_every
    above and sets the marker; a second pass adds nothing and writes nothing (idempotent).
  - No PR (`gh` "no pull requests found") ⇒ no item, no marker, no escalation; a later pass with a PR projects.
  - MERGED/CLOSED PR ⇒ marker only, no item.
  - `cherry-pick-ladder` and `stacked-prs` done items ⇒ no gh read, no item.
  - Collision: `pr-<n>` taken by another item ⇒ `pr-<basename>-<n>`, then `-2`.
  - An existing `github-pr` item with the same repo+pr ⇒ no duplicate.
  - The `decide` enumeration/table test gains the new Q1 guard combinations (done + merge-auto + unmarked ⇒ Q1;
    done + marked ⇒ wait).
- `internal/operatorloop` `judgment_test.go`: table cases for a `pr-<n>` `github-pr` item — `changed` ⇒
  judgment, `done` ⇒ judgment (and a pane queue item's `done` stays mechanical).
- Loop integration case (`loop_test.go`/`mechanical_test.go` style, with the gh/wt fakes): merge-auto item A
  done → pass projects `pr-<n>` → probe reports MERGED (`done`) → the next pass spawns successor B.
- `internal/operator` brief render/golden test: the new Merging line is present.

### 6. Docs (memory, at hydrate)

See Affected Memory. The Design Decision "merge-auto tracks, the run merges" records: the engine projects a
`github-pr` item for a shipped merge-auto item's PR and never readies/merges it; why (both holes above, the
judgment set already covers `github-pr`, the plan's PR-work decision); rejected (restore Q7 + P rows; queue
`done` as judgment; a per-PR checks watcher); introduced by this change.

### PR evidence

`No recording: internal CLI/engine behavior` (plan Rule 6); the PR body states the tests run.

## Affected Memory

- `run-kit/operator-autopilot`: (modify) Q1 row guard and executor (PR projection for merge-auto, retry when
  no PR, MERGED/CLOSED marker only); Projection items (the `pr-<n>` `github-pr` projection, its scope/probe/then,
  collision rule, dedupe, not engine-owned, never re-added after `track rm`); engine file schema (`pr_tracked`
  marker); Merge mode (merge-auto's engine half now also tracks the PR); new Design Decision "merge-auto tracks,
  the run merges"
- `run-kit/operator-loop`: (modify) § Judgment set — note that the engine-projected `pr-<n>` item's `changed`
  and `done` deltas are what launch the merge run and re-trigger the successor's barrier
- `run-kit/operator-brief`: (modify) § Merging — the `pr-<n>` / `then: merge-auto …` line and its authority rule
- `run-kit/operator-state`: (modify) only if its projection/`pr-<n>` paragraph needs the engine-projected PR item
  mentioned (it currently says a `pr-<n>` item is an ordinary ledger item — still true)

## Impact

- `app/backend/internal/autopilot/rules.go` (Q1 guard, `needsPRTrack`), `execute.go` (`recordDone` with ctx,
  projection), `gate.go` (`prView.Number`), `enginefile.go` (`pr_tracked` field, `applyEngineItem` /
  `engineItemFromTracked` carry it), `autopilot.go` (new `Act…` constant), possibly a new small file for the
  PR projection write; tests in `rules_test.go`, `passes_test.go`/`spawning_test.go`/`harness_test.go` fakes.
- `app/backend/internal/operator/` — `brief_rules.md` § Merging; possibly export of the `nameWithOwner` seam
  (`track.go` `ghNameWithOwnerFn`) for the engine; brief render/golden tests.
- `app/backend/internal/operatorloop/judgment_test.go`, a loop integration test.
- No HTTP API, frontend, CLI flag, or help-text change; `rk operator autopilot status --json` unchanged
  (queue items only). No `rk help-dump` fixture change expected.
- gh calls per pass: one `gh pr view` per done merge-auto item until it is marked (bounded; once per item in
  steady state), plus one `nameWithOwner` read per projection.

## Open Questions

- None blocking. The probe-field addition (`mergeStateStatus`) and the authority anchor (`scope.item`) go
  beyond the brief's literal text to meet its stated intent; see Assumptions.

## Non-goals

- The engine never arms, readies, merges, restacks or fixes a PR; no P/B/C/F rows return; no flag keeps PR
  executors reachable (plan Rule 7).
- No projection for `cherry-pick-ladder` or `stacked-prs` items.
- No change to `judgment.go` logic, the check, the trigger door, or T12's failed-run retry (separate step).
- **Review bar** (plan § Decisions, quoted for every review dispatch): must-fix = merges, pushes, deletes or
  spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix =
  everything else.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Engine only tracks: adds a `github-pr` ledger item for a done merge-auto item's PR; never readies/arms/merges | Brief text and plan decision "PR work — Back to the AI" / Rule 7 | S:95 R:80 A:95 D:95 |
| 2 | Certain | Only `merge-auto` items project; ladder and stacked project nothing | Brief states it explicitly | S:95 R:85 A:90 D:95 |
| 3 | Certain | Item shape: id `pr-<n>`, scope repo/pr/change, `done_when: state == "MERGED"`, `check_every 5m`, `then: "merge-auto: ready and merge this PR when its required checks are green"` | Verbatim from the brief | S:95 R:85 A:90 D:90 |
| 4 | Certain | Collision rule = pre-T3 `newPRItem`: `pr-<n>` → `pr-<basename(repo)>-<n>` → count up `-2`, `-3` | Brief says "the existing `pr-<n>` collision rule applies"; the rule is in git history at `b2c625b7^` | S:80 R:85 A:90 D:85 |
| 5 | Confident | Retry is implemented by widening Q1's guard (`done_at` unset OR merge-auto and not PR-tracked) with a `pr_tracked` engine-file marker, since Q1 otherwise never re-fires once `done_at` is written | Brief names the Q1 `record-done` executor and requires "next pass retries (the item stays done)"; a marker is the only idempotence source the pure `decide` can read | S:70 R:75 A:75 D:60 |
| 6 | Confident | Probe keeps `--repo <nwo>` (via `NewGitHubPRItem` and the `nameWithOwner` read) though the brief's argv omits it | `NewGitHubPRItem`/`defaultGitHubPRArgv` require it — a shell probe runs from the caller's cwd and would query the wrong repo; the brief's argv is shorthand | S:65 R:85 A:90 D:80 |
| 7 | Confident | Add `mergeStateStatus` to the probe fields | Brief expects a `changed` delta on checks; state/mergeable/isDraft do not move when required checks go green, so the run would never be re-triggered | S:60 R:85 A:80 D:70 |
| 8 | Confident | Scope also carries `item: <queue id>`, and the brief line anchors merge authority to that queue item's `merge_mode`, not to the `then` text | Brief rules say a non-queue `github-pr` item has no mode and needs a user note; `then` is user/run-writable, and "merges the wrong thing" is the review bar's first must-fix | S:55 R:80 A:75 D:65 |
| 9 | Confident | MERGED/CLOSED PR at projection time ⇒ marker only, no item; OPEN ⇒ item | Nothing left to merge; the barrier reads MERGED directly; avoids a pointless `done`-triggered run for pre-existing done items | S:50 R:85 A:75 D:70 |
| 10 | Confident | A ledger `github-pr` item with the same repo+pr already present ⇒ no duplicate, marker written | Brief: "a second pass is idempotent"; the chat may already track the PR by hand | S:60 R:85 A:80 D:75 |
| 11 | Confident | No-PR ⇒ silent retry; other gh/nwo failures ⇒ escalate (deduped) and retry | Matches `depMerged`/`depPRExists` handling of `noPRFound` vs other errors | S:65 R:85 A:85 D:75 |
| 12 | Confident | Loop and `judgment.go` get tests only, no logic change | Brief: "Loop: unchanged"; `reasonNeedsJudgment` already covers `github-pr` `changed`/`done` | S:90 R:90 A:90 D:90 |
| 13 | Confident | No recording; PR body states `No recording: internal CLI/engine behavior` | Plan Rule 6 for every non-drawer step | S:90 R:95 A:95 D:95 |

13 assumptions (4 certain, 9 confident, 0 tentative, 0 unresolved).
