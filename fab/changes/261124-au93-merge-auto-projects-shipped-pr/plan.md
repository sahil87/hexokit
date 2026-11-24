# Plan: merge-auto projects the shipped item's PR

**Change**: 261124-au93-merge-auto-projects-shipped-pr
**Intake**: `intake.md`

## Requirements

### Engine: Q1 tracks a shipped merge-auto item's PR (`app/backend/internal/autopilot`)

#### R1: Q1 re-fires until a merge-auto item's PR is tracked
Row Q1 (`record-done`, status `done`) SHALL match when the engine item's `done_at` is unset, OR when the item's
merge mode (`modeOf`) is `merge-auto` and its engine record carries no PR-tracked marker. The marker SHALL be a new
engine-file field `pr_tracked` (string, `omitempty`) on `engineItem`, exposed to the rule view as the scope key
`pr_tracked` (a new `scopePRTracked` constant, listed in `engineScopeKeys` so it never reaches a ledger item).
`engineItem.tracked()`, `engineItemFromTracked` and `applyEngineItem` SHALL carry it so a guarded write never drops
it. Every other done item SHALL keep deciding the declared `done` wait. `decide` SHALL stay a pure function of
(state, facts).

- **GIVEN** a merge-auto queue item whose engine `done_at` is set and `pr_tracked` is empty
- **WHEN** a pass decides
- **THEN** the item's decision is row Q1, action `record-done`
- **AND** once `pr_tracked` is set, the same item decides the `done` wait

- **GIVEN** a `cherry-pick-ladder` or `stacked-prs` item whose `done_at` is set
- **WHEN** a pass decides
- **THEN** it decides the `done` wait (no Q1, no gh read)

#### R2: record-done projects an OPEN PR as a `github-pr` ledger item
`recordDone` SHALL take a `ctx` and, after writing `done_at` when unset (unchanged behavior, `ActDone`), for a
merge-auto item with no marker: resolve the branch with `itemBranch(st, it)` from a fresh engine view, read the PR
with `e.viewPR(ctx, repo, branch, "number,url,state")` (`prView` gains `Number int \`json:"number"\``), and when the
PR is `OPEN` add a ledger item with exactly:

```yaml
id: pr-<n>
kind: github-pr
probe: {mode: shell, argv: [gh, pr, view, "<n>", --repo, "<owner/name>", --json, "state,mergedAt,mergeable,isDraft,mergeStateStatus"],
        fields: [state, mergedAt, mergeable, isDraft, mergeStateStatus]}
check_every: 5m
done_when: state == "MERGED"
then: "merge-auto: ready and merge this PR when its required checks are green"
depends_on: []
scope: {repo: <queue item's scope.repo>, pr: <n>, change: <view change, may be "">, item: <queue item id>}
```

The item SHALL be built with `operator.NewGitHubPRItem(id, nil, scope, nwo)` and then given the argv/fields,
`check_every` and `then` above. `nwo` SHALL be read through the engine's runner (`e.gh(ctx, repo, "repo", "view",
"--json", "nameWithOwner", "-q", ".nameWithOwner")`, trimmed, cached per repo in `repoMeta`). After the ledger write
succeeds the executor SHALL write `pr_tracked: <item id>` through the fingerprint-free engine write path and emit
`e.act(ActPRTracked, <queue id>, <item id>)` (new constant `ActPRTracked = "pr-tracked"` beside `ActDone`). The
engine SHALL NOT run `gh pr ready|merge|edit` or any other PR mutation.

- **GIVEN** a merge-auto item `a` done on branch `a-branch` with OPEN PR #41 in repo `owner/name`
- **WHEN** `Step` runs
- **THEN** the ledger holds `pr-41` (kind `github-pr`) with the probe, `check_every: 5m`, `done_when`, `then` and
  scope `{repo, pr: 41, change, item: a}` above, the engine item's `pr_tracked` is `pr-41`, and the result has a
  `pr-tracked` action for `a`
- **AND** no `gh pr ready`, `gh pr merge` or `gh pr edit` call was made

#### R3: Lookup outcomes other than OPEN
- No PR (`noPRFound(err)`): nothing projected, no marker, no escalation — the next pass retries (Q1 still matches).
- `MERGED` or `CLOSED`: no ledger item; write the marker (`pr_tracked: merged` / `pr_tracked: closed`).
- No branch recorded: escalate `cannot track PR: no branch recorded` (deduped by the existing escalation key), no marker.
- Any other `gh pr view` failure, or a failed/empty `nameWithOwner` read: escalate `PR lookup failed: <stderr>` /
  `PR repo lookup failed: <stderr>`, no marker (retry next pass).
- A failed ledger write: escalate the error, no marker.

- **GIVEN** a done merge-auto item whose branch has no PR
- **WHEN** `Step` runs, then a PR is opened, then `Step` runs again
- **THEN** the first pass adds no item, writes no marker and reports no escalation; the second projects `pr-<n>`

- **GIVEN** a done merge-auto item whose PR reads MERGED
- **WHEN** `Step` runs
- **THEN** no ledger item is added and `pr_tracked` reads `merged`

#### R4: Idempotence, dedupe and the id collision rule
Inside the single `operator.Mutate` that adds the item: if a ledger item of kind `github-pr` already has the same
`scope.pr` and a `scope.repo` equal under `samePath`, add nothing (the marker is still written, naming that item's
id). Otherwise the id is `pr-<n>`; if taken by any ledger item, `pr-<filepath.Base(repo)>-<n>`; if that is taken,
`pr-<filepath.Base(repo)>-<n>-2`, `-3`, … until free (the pre-T3 `newPRItem` rule). The same write SHALL refuse
(`errItemChanged` → `changedText` escalation, no marker) when the source queue item no longer exists in the engine
view. A user `track rm` of the projected item SHALL never be undone (the marker stays set).

- **GIVEN** a pass already projected `pr-41` for `a`
- **WHEN** `Step` runs again
- **THEN** no gh call is made for `a`, the ledger is unchanged and no `pr-tracked` action is reported
- **GIVEN** a ledger item `pr-41` that is a different item (another repo or kind)
- **WHEN** `a`'s PR #41 is projected
- **THEN** the new item's id is `pr-<basename(repo)>-41` (and `-2` when that is taken too)
- **GIVEN** a `github-pr` item already tracking the same repo and PR #41 under any id
- **WHEN** `a` is projected
- **THEN** no new item is added and `pr_tracked` names the existing id

#### R5: The projected item is an ordinary ledger item
The `pr-<n>` item SHALL NOT be engine-owned: `OwnedIDs`, `QueueEntries` and `status` keep listing queue items only;
the item is never added to the engine file's `queue`; `autopilot rm pr-<n>` stays a usage error. The judgment set
already treats its `changed`/`done` deltas as judgment (`operatorloop/judgment.go` `reasonNeedsJudgment`, no code
change).

- **GIVEN** a projected `pr-41`
- **WHEN** `OwnedIDs` is read
- **THEN** `pr-41` is absent

#### R6: The successor spawns after the projected PR merges
With A and B queued `merge-auto`, B depending on A (same repo): after A is done and `pr-<n>` is projected, once A's
PR reads MERGED the next `Step` SHALL spawn B (the existing barrier `depMerged`; no new code beyond R1–R4).

- **GIVEN** A done with `pr-41` projected and B held on A's merge barrier
- **WHEN** PR #41 becomes MERGED (and the check records the `pr-41` item done) and `Step` runs
- **THEN** B is spawned

### Loop: judgment cases (`app/backend/internal/operatorloop`)

#### R7: A projected `pr-<n>` item's deltas are judgment
`judgmentSet` SHALL include a `github-pr` item with scope `{repo, pr, item}` and a `then: merge-auto …` for a
`changed` delta and for a `done` delta, while a `done` delta on a `pane` queue item (owned) stays out. Tests only.

- **GIVEN** changes `pr-41: changed` and `pr-41: done` on the projected item, and `a: done` on the owned pane item
- **WHEN** `judgmentSet` runs
- **THEN** `pr-41` is in the set for both and `a` is not

### Brief: § Merging (`app/backend/internal/operator/brief_rules.md`)

#### R8: The run knows what a projected item is and who authorizes the merge
§ Merging's `merge-auto` bullet SHALL gain the line: a `pr-<n>` item carrying `then: merge-auto …` was projected by
the engine for a shipped merge-auto queue item (`scope.item`); it is the PR to ready and merge when green —
`gh pr ready <n>` if draft, then `gh pr merge <n> --squash --match-head-commit <observed-head-sha>`; red checks
follow the fix-request rule. The confirmation-tiers paragraph ("A `github-pr` item that is not a queue item has no
mode…") SHALL add the exception: such an item's authority is the mode of the queue item its `scope.item` names
(`merge_mode` in `rk operator autopilot status -L <server> --json`); its `then` text alone is never authority.
`brief_test.go` SHALL assert the new text; `testdata/brief_golden.md` SHALL be regenerated (`UPDATE_GOLDEN=1`).

- **GIVEN** a rendered brief
- **WHEN** the Merging section is read
- **THEN** it names the `pr-<n>` / `then: merge-auto` item, `gh pr ready`, `--match-head-commit`, and the
  `scope.item` authority rule

### Chat skill (`docs/site/skill/operator.md`)

#### R9: The chat skill says who tracks a merge-auto PR
The `merge-auto` Merging line (around line 163) SHALL gain one sentence: under `merge-auto` the engine tracks each
shipped item's PR as a `pr-<n>` ledger item (`then: merge-auto …`, `scope.item` = the queue item) and a run merges
it when green; the chat merges it the same way when asked. `scripts/sync-skill.sh` (via its `just` recipe or
directly) SHALL copy it to `app/backend/cmd/rk/skill/operator.md` so the drift guard stays green.

- **GIVEN** the skill source and its synced copy
- **WHEN** the drift guard test runs
- **THEN** they match and both carry the sentence

### Non-Goals

- The engine never arms, readies, merges, restacks or fixes a PR; no P/B/C/F rows; no flag keeps PR executors (plan Rule 7).
- No projection for `cherry-pick-ladder` / `stacked-prs` items.
- No change to `judgment.go`, `operator.Check`, the trigger door, or T12's failed-run retry.
- Review bar (plan § Decisions): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts
  state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.

### Design Decisions

#### merge-auto tracks, the run merges
**Decision**: When a `merge-auto` queue item is done, Q1 `record-done` projects its branch's open PR as an ordinary
`github-pr` ledger item `pr-<n>` (`then: merge-auto …`, `scope.item` = the queue item, `done_when: state ==
"MERGED"`, `check_every 5m`), retrying each pass until the PR exists, and records `pr_tracked` in the engine file.
The engine never readies or merges; the item's `changed`/`done` deltas launch the run that merges it, and its MERGED
fire runs the pass that spawns the successor.
**Why**: After the PR rows were deleted nothing tracked a shipped item's PR: a queue item's `done` is not judgment
and a done pane yields no further edge, so no run merged the green PR, and a merge was not an edge, so the
successor's barrier waited for an unrelated fire. A `github-pr` ledger item is the existing way to make a PR
observable, and its deltas are already judgment.
**Rejected**: Restoring Q7 and the P rows (contradicts "PR work back to the AI"); making a queue item's `done` a
judgment reason (one shot, and a merge still is not an edge); a per-PR `gh pr checks --watch` (rejected by the plan's
PR-trigger decision).
*Introduced by*: 261124-au93-merge-auto-projects-shipped-pr

## Tasks

### Phase 1: Setup

- [x] T001 Add the PR-tracked marker: `PRTracked string \`yaml:"pr_tracked,omitempty" json:"pr_tracked,omitempty"\`` on `engineItem` (`app/backend/internal/autopilot/enginefile.go`); `scopePRTracked = "pr_tracked"` in the scope-key block of `queue.go`; add it to `engineScopeKeys` (`migrate.go`); carry it in `engineItem.tracked()` (set the scope key only when non-empty), `engineItemFromTracked` (`operator.ScopeString(it.Scope, scopePRTracked)`), and keep it in `applyEngineItem`; add `ActPRTracked = "pr-tracked"` to the Act constants in `autopilot.go`; add `Number int \`json:"number"\`` to `prView` in `gate.go` <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 Widen Q1 in `app/backend/internal/autopilot/rules.go`: add `needsPRTrack(c *ruleCtx) bool` (`modeOf(c.it) == operator.MergeModeMergeAuto && operator.ScopeString(c.it.Scope, scopePRTracked) == ""`) and set Q1's guard to `doneAtUnset(c) || needsPRTrack(c)`; update the table's doc comment <!-- R1 -->
- [x] T003 Implement the projection in a new file `app/backend/internal/autopilot/prtrack.go`: `(e *engine) trackPR(ctx, d Decision)` (branch via a fresh `engineView` + `itemBranch`, `viewPR` number/url/state, the R3 outcome table, `nameWithOwner` via `e.gh` cached in `repoMeta`), `addPRProjection` (one `operator.Mutate`: source queue item still in the engine view else `errItemChanged`; dedupe by `kind == github-pr` + `scope.pr` + `samePath(scope.repo)`; id collision rule; build with `operator.NewGitHubPRItem`, then set `Probe.Argv`/`Probe.Fields`/`CheckEvery` (`"5m"`)/`Then`), and the marker write (`e.mutateEngine` → `st.find(id)` → `PRTracked = …`, `ErrNoWrite` when already equal); `repoMeta` gains an `nwo string` field (`repo.go`) <!-- R2 -->
- [x] T004 Wire it in `app/backend/internal/autopilot/execute.go`: `execute` passes `ctx` to `recordDone(ctx, d)`; `recordDone` writes `done_at` only when the engine `done_at` is unset (re-read the engine item; keep `ActDone` + "completion observed" only for that write), then calls `trackPR` when the item is merge-auto and unmarked; no PR mutation calls anywhere <!-- R2 -->

### Phase 3: Integration & Edge Cases

- [x] T005 Test support in `app/backend/internal/autopilot/harness_test.go`: `ghSim.handle` returns `number` in `pr view` JSON and answers `gh repo view --json nameWithOwner -q .nameWithOwner` with a configurable `nwo` (default `owner/name`) while keeping the existing `defaultBranchRef` reply; `simPR` states MERGED/CLOSED usable <!-- R2 -->
- [x] T006 New `app/backend/internal/autopilot/prtrack_test.go`: OPEN ⇒ exact item shape + marker + `pr-tracked` action + no `gh pr ready|merge|edit` calls; second pass idempotent (no gh `pr view` for the item, no new action); no PR ⇒ nothing then projected on a later pass; MERGED ⇒ marker `merged`, no item; CLOSED ⇒ marker `closed`; ladder and stacked done items ⇒ no `gh pr view` for them and no item; collision `pr-<n>` taken ⇒ `pr-<base>-<n>`, then `-2`; existing same repo+pr `github-pr` item ⇒ no duplicate; gh failure ⇒ escalation, no marker, retried; `track rm` of the projected item ⇒ not re-added; `OwnedIDs` excludes the item <!-- R3 -->
- [x] T007 Update the `decide` table/enumeration tests (`app/backend/internal/autopilot/rules_test.go` and any `revised_rules_test.go` combination enumeration) for the new Q1 guard: done + merge-auto + unmarked ⇒ Q1; done + marked ⇒ wait; done + other modes ⇒ wait; fix any existing tests whose merge-auto done items now hit Q1 (script the gh sim for them rather than weakening assertions) <!-- R1 -->
- [x] T008 Engine chain integration test in `prtrack_test.go`: queue A, B `merge-auto` (B depends on A, same repo), A spawned then done with an OPEN PR ⇒ `Step` projects `pr-<n>` and B stays held; set the sim PR MERGED and mark the `pr-<n>` ledger item done (as `operator.Check` would on `done_when`) ⇒ next `Step` spawns B <!-- R6 -->
- [x] T009 [P] `app/backend/internal/operatorloop/judgment_test.go`: table cases for a projected `pr-41` `github-pr` item (`then: merge-auto …`, scope with `item`) — `changed` ⇒ judgment, `done` ⇒ judgment; the owned pane queue item's `done` stays mechanical <!-- R7 -->

### Phase 4: Polish

- [x] T010 [P] `app/backend/internal/operator/brief_rules.md` § Merging `merge-auto` bullet + the confirmation-tiers authority exception per R8; assert the new text in `brief_test.go` (the Merging assertions near lines 388/448); regenerate `testdata/brief_golden.md` with `UPDATE_GOLDEN=1` and review the diff (only the new lines) <!-- R8 -->
- [x] T011 [P] `docs/site/skill/operator.md` sentence per R9, then sync to `app/backend/cmd/rk/skill/operator.md` (`scripts/sync-skill.sh`) <!-- R9 -->
- [x] T012 Run `just test-backend` (all Go tests green except the two known host-only failures `cmd/rk TestPortPinRowRealPolicyValues` and `rk/api TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`), `gofmt -l` clean, `go vet ./internal/autopilot/... ./internal/operatorloop/... ./internal/operator/...` <!-- R1 -->

## Execution Order

- T001 blocks T002–T004; T005 blocks T006–T008; T004 blocks T006–T008.
- T009, T010, T011 are independent of the engine work.

## Acceptance

### Functional Completeness

- [x] A-001 R1: Q1's guard is `done_at` unset OR (merge-auto AND `pr_tracked` empty); `pr_tracked` round-trips through the engine file and every guarded write, and never appears in a ledger item's scope
- [x] A-002 R2: an OPEN PR on a done merge-auto item yields a `github-pr` item with exactly the R2 id, probe argv/fields (with `--repo <nwo>`), `check_every: 5m`, `done_when`, `then`, empty `depends_on` and scope `{repo, pr, change, item}`; the marker names it; a `pr-tracked` action is reported
- [x] A-003 R3: no PR ⇒ nothing and a later retry; MERGED/CLOSED ⇒ marker only; branch/gh/nwo/write failures ⇒ escalation and no marker
- [x] A-004 R4: a second pass is a no-op; same repo+pr already tracked ⇒ no duplicate; id collision follows `pr-<n>` → `pr-<base>-<n>` → `-2…`; a removed projected item is not re-added
- [x] A-005 R5: `OwnedIDs`, `QueueEntries` and `status` exclude the projected item
- [x] A-006 R6: the integration test shows done → `pr-<n>` → MERGED → successor spawned on the next pass
- [x] A-007 R7: judgment tests cover `pr-<n>` `changed` and `done`, and a queue item's `done` stays mechanical
- [x] A-008 R8: `brief_rules.md` § Merging carries the projected-item line and the `scope.item` authority exception; brief tests and golden pass
- [x] A-009 R9: the chat skill carries the sentence and its synced copy matches

### Behavioral Correctness

- [x] A-010 R1: `cherry-pick-ladder` and `stacked-prs` done items behave exactly as before (wait, no gh read)
- [x] A-011 R2: the engine issues no `gh pr ready|merge|edit` or any PR-mutating call

### Scenario Coverage

- [x] A-012 R3: tests exist for OPEN, no-PR-then-PR, MERGED, CLOSED and gh-failure outcomes
- [x] A-013 R4: tests exist for idempotence, dedupe, both collision steps, and `track rm` of the projection

### Edge Cases & Error Handling

- [x] A-014 R4: a source queue item removed between decide and the ledger write produces `changedText` and no item
- [x] A-015 R2: the `nameWithOwner` read is cached per repo and a failure is an escalation, not a crash

### Code Quality

- [x] A-016 Pattern consistency: the executor follows the re-read/guarded-write/escalate patterns of `execute.go` and `gate.go`; no god function over ~50 lines
- [x] A-017 No unnecessary duplication: reuses `viewPR`, `noPRFound`, `itemBranch`, `samePath`, `operator.NewGitHubPRItem`, `escalate`, `mutateEngine`
- [x] A-018 Subprocess calls go through the engine runner (`exec.CommandContext` with timeout via `ExecRunner`); no shell strings
- [x] A-019 Named constants for the `then` text, `check_every` and probe fields; no magic strings inline
- [x] A-020 Comments state constraints only — no narration, no change IDs or PR numbers
- [x] A-021 `just test-backend` passes apart from the two known host-only failures; `gofmt` clean

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The projection lives in a sibling file `prtrack.go` with its own ledger write, not in `upsertProjection` | `upsertProjection` builds pane items (`NewPaneItem`, pane-only scope, `branch_map`, the `projected` flag); a `github-pr` item needs a different constructor and dedupe | S:70 R:85 A:80 D:75 |
| 2 | Confident | `nameWithOwner` is read through the engine runner (`e.gh`), cached in `repoMeta`, not via `operator`'s unexported `ghNameWithOwnerFn` | Keeps every engine subprocess on the scripted runner the tests fake; no new exported seam in `operator` | S:65 R:90 A:80 D:70 |
| 3 | Confident | Marker values: the projected/deduped item id, or `merged` / `closed` when nothing was projected | One string field answers both "is it tracked" and "by what", readable in the engine file by a human | S:60 R:85 A:75 D:65 |
| 4 | Confident | A merge-auto item that never gets a PR (e.g. a `stop_stage` before ship) is re-read once per pass indefinitely | Bounded cost — passes run only on fires with changes, one `gh pr view` per such item; a cap would need state the brief did not ask for | S:55 R:85 A:70 D:60 |
| 5 | Confident | The loop integration case is split: engine chain in `autopilot` (its gh/spawn fakes) and judgment cases in `operatorloop` | A single test spanning `operator.Check` + `run-exec` + `Step` needs a real tmux server and gh; the existing helper path uses real tmux | S:60 R:90 A:80 D:70 |
| 6 | Confident | `recordDone` keeps reporting `ActDone` only on the pass that writes `done_at`; later retries report only `pr-tracked` (or nothing) | A retry pass must not re-announce a completion the user already saw | S:65 R:90 A:85 D:75 |
| 7 | Certain | Projection probe adds `mergeStateStatus` and keeps `--repo <nwo>` (intake assumptions 6–7) | Carried from intake | S:85 R:85 A:85 D:85 |
| 8 | Confident | `pr-tracked` is reported only when a ledger item exists (new or deduped); a MERGED/CLOSED marker-only write reports nothing | Nothing was tracked, so the run record has nothing to show; the marker is visible in the engine file | S:60 R:90 A:80 D:70 |
| 9 | Confident | The ledger write's source-item guard is existence in the engine file, not the decided fingerprint | `done_at` is written first in the same executor, which changes the fingerprint; R4 asks only that a vanished source item be refused | S:65 R:90 A:80 D:75 |
| 10 | Confident | The collision "taken" set includes queue item ids as well as ledger ids | A ledger item sharing a queue item's id would overlay its facts onto the queue item (engineView), corrupting state | S:70 R:90 A:85 D:80 |
| 11 | Confident | A `gh repo view` answer that is not a valid owner/name escalates `PR repo lookup failed: …` and leaves the marker unset | Keeps a bad answer from becoming a hard `Step` error; the same validator `NewGitHubPRItem` applies | S:65 R:90 A:85 D:75 |
| 12 | Confident | An unknown PR state (not OPEN/MERGED/CLOSED) projects nothing and sets no marker | Retry on the next pass; no state to act on | S:55 R:90 A:80 D:70 |
| 13 | Confident | `operatorloop/restart_test.go`'s gh fake answers `repo view --json nameWithOwner` with plain text (as `-q` makes real gh do) and the mechanical run now reports 2 actions (done + pr-tracked) | The fake ignored `-q`; the merge-auto item there ships an open PR, which the spec now tracks | S:70 R:85 A:80 D:70 |

13 assumptions (1 certain, 12 confident, 0 tentative).
