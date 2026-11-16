# Plan: Fab-First PR Source + Branch-Reuse Ownership Check

**Change**: 261116-jiu2-fab-first-pr-branch-reuse
**Intake**: `intake.md`

## Requirements

### PR Status: Branch-Fallback Ownership

#### R1: Merged/closed branch candidates require ancestry ownership
In the branch→PR derivation (`BranchRefresher.refreshWhere`, both the viewer head-index join and the
`gh pr list` fallback, and therefore `RefreshURLs`), an OPEN candidate SHALL match by branch name
alone. A MERGED or CLOSED candidate SHALL be attributed only when its `headRefOid` is the local
`HEAD` or an ancestor of it — `git merge-base --is-ancestor <headRefOid> <HEAD-sha>` run with
`cmd.Dir = repoDir` exits 0. Exit 1 (not an ancestor), exit 128 (object unknown locally), and an
empty `headRefOid` SHALL each mean **not owned**. Ownership filtering MUST happen before precedence
picking, so `pickBranchCandidate` ranks only attributable candidates.

- **GIVEN** a fresh worktree on main tip whose branch name equals the head of an old MERGED PR
- **WHEN** the refresher resolves the pair and `--is-ancestor` exits 1 (or 128)
- **THEN** the pair resolves to an authoritative negative on the gh path (no PrURL/PrNumber)
- **AND** the PANE `pr` line and row PR glyph are absent

- **GIVEN** a branch whose merged PR's head commit is in HEAD's history (with or without later commits)
- **WHEN** the refresher resolves the pair
- **THEN** the merged PR is attributed (invariant 6 durability preserved)

- **GIVEN** a branch with an OPEN PR whose head commit is not in local history
- **WHEN** the refresher resolves the pair
- **THEN** the OPEN PR is attributed and no git ownership subprocess runs

#### R2: Index-path all-filtered is a miss; gh-path all-filtered is a negative
On the viewer head-index path, a candidate set whose candidates are all filtered out SHALL be a
**miss** (fall through to the gh path; the index is never an authoritative negative). On the gh path,
a successfully parsed result whose candidates are all filtered out SHALL be an authoritative negative
(`pr = nil`, `negativeAt = now`), exactly like a parsed empty result.

- **GIVEN** the viewer index holds only a not-owned MERGED candidate for the pair
- **WHEN** a pass runs
- **THEN** the pair falls through to `gh pr list`, whose filtered result decides the entry

#### R3: Transient ownership failure keeps last-good
When the ownership check fails for a reason other than exit 1/128 (timeout, git missing, other error,
or `git rev-parse HEAD` failure), the pass SHALL keep the pair's last-good entry untouched — no
positive and no negative written for that pair this pass — and retry on the next pass.

- **GIVEN** a pair with a last-good MERGED positive
- **WHEN** the `--is-ancestor` seam returns a non-exit-status error (e.g. context deadline)
- **THEN** the entry is unchanged after the pass (still positive, `negativeAt` unchanged)

#### R4: `headRefOid` carried on every candidate source
`branchPRExec` SHALL request `--json number,url,state,updatedAt,isDraft,headRefOid`. The viewer
GraphQL query SHALL select `headRefOid`; `ghPR`, `ViewerPR` (`HeadOid`), and `BranchPR`
(`HeadRefOid string json:"headRefOid"`) SHALL carry it, and `storeViewerIndex` SHALL copy it into
index candidates. The disk seed DTOs (`diskViewerPR`, `diskBranchPR`) SHALL carry an optional
`headRefOid` (`omitempty`); an absent field loads as empty (→ not owned when merged/closed, until the
next fresh pass re-derives it).

- **GIVEN** a GraphQL batch node with `headRefOid: "abc"`
- **WHEN** it is parsed and stored into the viewer index
- **THEN** the index candidate's `HeadRefOid` is `"abc"`

#### R5: Ownership git checks are off the hot path, bounded, and cached
Ownership subprocesses SHALL run only on the refresher goroutine, only when a MERGED/CLOSED candidate
needs adjudication (no git call when an OPEN candidate exists or there are no candidates), via
`exec.CommandContext` with a timeout and explicit argv, outside `r.mu`, behind per-instance seams
defaulting to package vars (mirroring `branchDefaultExec`/`branchOriginExec`). `HEAD` SHALL be
resolved at most once per repo per pass (`git rev-parse HEAD`). Definite verdicts (owned / not owned)
SHALL be cached keyed by `(repoDir, headRefOid, HEAD)` without a TTL (ancestry of two fixed commits
is immutable); the cache SHALL be pruned for repos no live pair observes (Constitution §II bounded
memory). Transient failures SHALL NOT be cached.

- **GIVEN** a cached owned verdict for `(repo, oid, head)`
- **WHEN** the next pass adjudicates the same candidate at the same HEAD
- **THEN** no `--is-ancestor` subprocess runs

### PR Status: Fab-First PR Identity

#### R6: `fabstatus` extracts the change's last PR URL
`fabstatus.State` SHALL gain `PRURL string`: the last non-empty scalar entry of the `.status.yaml`
top-level `prs:` sequence, extracted in the same single `yaml.Node` parse that reads `progress:`. An
absent key, empty sequence, non-sequence value, or non-scalar items SHALL yield `PRURL = ""` and MUST
NOT change the existing Change/Stage/DisplayState derivation. The operator-check consumer ignores
the field.

- **GIVEN** `prs:` with two URLs
- **WHEN** the window is derived
- **THEN** `PRURL` is the second URL

#### R7: Fab-bound windows take PR identity from `prs:`
`enrichWindowPR` SHALL take the window's fab rollup PR URL (from `fabMemo.WindowState`, even when the
fab-bound pane differs from `windowPRKey`'s pane, and even on the repo's default branch). When that
URL parses as a GitHub PR URL (`/pull/<n>` path segment), the window's `PrURL`/`PrNumber` SHALL come
from it and the branch path (`Register` + `SnapshotBranchPR`) SHALL NOT run for that window. When the
URL is empty or unparsable, the branch path SHALL run as today (with R1–R5). The hot path MUST stay
zero-subprocess/zero-network.

- **GIVEN** a fab-bound window whose change has `prs: [.../pull/1073]` and whose branch would resolve PR #900
- **WHEN** `FetchSessions` enriches it
- **THEN** `PrNumber` is 1073 and the branch pair is not registered

- **GIVEN** a fab-bound window with `prs: []`
- **WHEN** enriched
- **THEN** the branch path supplies the PR as before

#### R8: By-URL background resolution for fab-sourced PRs
The refresher SHALL expose a URL-keyed façade — `RegisterURL(url)` (cheap set touch; signals the
coalescing wake on first sight) and `SnapshotURLPR(url) (*BranchPR, bool)` (in-memory read) — and
resolve registered URLs on its pass: first from the viewer collector's data when the URL is covered
(no subprocess), otherwise via `gh pr view <url> --json number,url,state,isDraft,updatedAt,headRefOid`
(`exec.CommandContext`, `ghTimeout`, argv; gated on the same lazy per-pass availability probe).
Transient errors and parse failures keep last-good. A URL whose last-good state is MERGED SHALL NOT
be re-queried (terminal). URL entries age out with the same observed/retain TTLs as branch entries.
`RefreshURLs(urls)` SHALL also re-resolve URL entries in its set. On a hit `enrichWindowPR` SHALL set
`PrState = MapBranchState(pr.State)`, `PrIsDraft = pr.IsDraft`, and SHALL replace `PrURL` with the
resolved canonical `pr.URL` when non-empty (so a pre-rename `run-kit` URL joins the collector).
Before the first resolution lands, `PrState` stays `""` (unknown, never `open`).

- **GIVEN** a fab `prs:` entry `https://github.com/sahil87/run-kit/pull/811`
- **WHEN** the by-URL resolution returns url `https://github.com/sahil87/hexokit/pull/811`, state MERGED
- **THEN** the window's `PrURL` is the hexokit URL and `PrState` is the merged mapping
- **AND** subsequent passes issue no further `gh pr view` for it

- **GIVEN** a freshly registered URL with no resolution yet
- **WHEN** the window is enriched
- **THEN** `PrURL`/`PrNumber` come from the recorded URL and `PrState` is `""`

### Docs: Status Pyramid Spec

#### R9: Spec reflects the new L3 source
`docs/specs/status-pyramid.md` SHALL state the L3 PR source as: fab `.status.yaml` `prs:` (last entry,
by-URL resolved) for fab-bound windows, else branch → gh lookup with the merged/closed ancestry
ownership check; invariant 6 SHALL note the branch-reuse rule (merged/closed attribution requires the
PR head in HEAD's history; OPEN by name).

- **GIVEN** a reader of status-pyramid.md L3 row and invariant 6
- **WHEN** they look up how a pane's PR is chosen
- **THEN** both sources and the ownership rule are described

### PR Evidence

#### R10: Before/after recording of the reused-name case
The change SHALL carry a `just demo` web-lane spec showing a rig pane in a fresh worktree whose branch
name equals the head ref of a historical MERGED hexokit PR, at `origin/main` (before: merged PR glyph
and PANE `pr` line shown; after: none), plus a positive control pane on a branch containing a merged
PR's head commit (fetched via `git fetch origin pull/<n>/head`) that still shows its merged PR, with
real `gh` (Constitution § PR Evidence).

- **GIVEN** `just demo pr-branch-reuse --before`
- **WHEN** it completes
- **THEN** before/after desktop+mobile videos exist under `.demo/` with the stale glyph present only in `before`

### Non-Goals

- Persisting URL entries to the disk seed cache — cold start resolves them on the first wake pass (~2.5 s); identity renders meanwhile.
- Frontend changes — the observable change is which PR populates the existing `WindowInfo` fields.
- Changing the default-branch carve-out (#389) for the branch path.

### Design Decisions

#### Fab `prs:` outranks branch derivation for fab-bound windows
**Decision**: A fab-bound window whose change records PRs takes identity from the last `prs:` entry; branch derivation is a fallback.
**Why**: The fab record is explicit and already read on the hot path; name matching is degenerate under `wt` name reuse.
**Rejected**: Reverting entirely to `prs:` (loses non-fab panes — the reason #314 moved to branch derivation).
*Introduced by*: 261116-jiu2-fab-first-pr-branch-reuse

#### Merged/closed ownership by commit ancestry
**Decision**: A merged/closed PR found by head name is attributed only when its `headRefOid` is an ancestor of (or equal to) local HEAD.
**Why**: Proves the branch contains that PR's work; survives new commits on a reused-name branch (unlike an ahead-of-default count) and keeps genuine merged branches purple.
**Rejected**: "commits ahead of default OR HEAD == headRefOid" (re-attaches the stale PR once work lands); PR createdAt vs reflog branch-creation (more moving parts).
*Introduced by*: 261116-jiu2-fab-first-pr-branch-reuse

## Tasks

### Phase 1: Setup

- [x] T001 Add `HeadRefOid string \`json:"headRefOid"\`` to `BranchPR` and `headRefOid` to the `branchPRExec` `--json` field list in `app/backend/internal/prstatus/prstatus_branch.go`; add `headRefOid` to `ghQuery`'s node selection, `ghPR`, `ViewerPR` (`HeadOid`), `viewerPRsFrom`, and the `storeViewerIndex` candidate copy in `app/backend/internal/prstatus/prstatus.go` / `prstatus_branch.go`; add optional `headRefOid,omitempty` to `diskViewerPR`/`diskBranchPR` and their converters in `app/backend/internal/prstatus/prstatus_disk.go` <!-- R4 -->

### Phase 2: Core Implementation

- [x] T002 Add ownership seams to `BranchRefresher` in `app/backend/internal/prstatus/prstatus_branch.go`: package vars `branchHeadExec` (`git rev-parse HEAD`) and `branchAncestorExec` (`git merge-base --is-ancestor <oid> <head>`, returning a tri-state verdict: owned on exit 0, not-owned on `*exec.ExitError` exit 1 or 128, unknown on any other error) with `exec.CommandContext` + timeout + argv + `cmd.Dir = repoDir`; per-instance fields defaulting to them in `NewBranchRefresher`; an `ancestry` cache map keyed `(repoDir, oid, head)` storing only definite verdicts with a taken-at stamp <!-- R5 -->
- [x] T003 Implement the ownership filter (e.g. `ownedCandidates(ctx, now, repoDir, cands, headMemo) (owned []BranchPR, unknown bool)`) in `prstatus_branch.go`: if any OPEN URL-bearing candidate exists return candidates unchanged with no git call; otherwise drop MERGED/CLOSED candidates with empty `HeadRefOid` or a not-owned verdict; resolve HEAD once per repo per pass via a pass-local memo; any unknown verdict or HEAD failure → `unknown = true` <!-- R1 -->
- [x] T004 Wire the filter into `refreshWhere` in `prstatus_branch.go`: index path — `viewerIndexPR` filters before `pickBranchCandidate`; all filtered → miss (fall through); unknown → keep last-good and `continue`. gh path — split `pickBranchPR` into a parse step (`parseBranchPRs`) + filter + `pickBranchCandidate`; all filtered → authoritative negative with `negativeAt = now`; unknown → keep last-good and `continue`. Prune `ancestry` entries for repos not in `liveRepos` on the full tick <!-- R1, R2, R3 -->
- [x] T005 Extend `app/backend/internal/fabstatus/fabstatus.go`: `State.PRURL`; replace `parseProgressStates` usage with one `yaml.Node` walk returning both the ordered progress pairs and the last non-empty scalar entry of a top-level `prs:` sequence (malformed → ""); `parseFabStatusLink` sets `PRURL` only on an otherwise-valid derivation <!-- R6 -->
- [x] T006 Add the URL-keyed resolution to `app/backend/internal/prstatus/prstatus_branch.go`: `urlEntries` map (pr, observedAt, seeded=false) guarded by `r.mu`; `(*BranchRefresher).RegisterURL` (signals wake on first sight) / `SnapshotURL`; package façade `RegisterURL` / `SnapshotURLPR` on `DefaultBranchRefresher`; package var seam `branchPRViewExec` (`gh pr view <url> --json number,url,state,isDraft,updatedAt,headRefOid`, `ghTimeout`, argv); a viewer URL map (built in `storeViewerIndex`, keyed by URL) used before gh; resolve in `refreshWhere` after the pair loop (full tick: age-out with the branch TTLs; targeted pass: only URLs in `onlyURLs`); skip re-query when last-good state is MERGED; transient/parse error keeps last-good; gh gated on the shared lazy `ghAvailableNow` <!-- R8 -->
- [x] T007 Change `enrichWindowPR(w *tmux.WindowInfo, fabPRURL string)` in `app/backend/internal/sessions/sessions.go`: parse the PR number from the `/pull/<n>` segment (pure string parse, helper with test); on success `prstatus.RegisterURL`, set identity, overlay `SnapshotURLPR` (state via `MapBranchState`, draft, canonical URL) and return without touching the branch path; otherwise the existing branch path. Pass `fab.PRURL` from the per-window loop (the `fab := fabMemo.WindowState(...)` value, hoisted if needed). Update the function's doc comment to the new two-source rule <!-- R7, R8 -->

### Phase 3: Integration & Edge Cases

- [x] T008 [P] Tests in `app/backend/internal/prstatus/prstatus_branch_test.go`: OPEN with oid not in history attributed + zero ownership calls; MERGED exit 1 → negative on gh path (`negativeAt` stamped); MERGED exit 128 → negative; MERGED without oid → negative; MERGED exit 0 → positive; index candidate not owned → falls through to gh; transient ancestor error keeps a last-good positive untouched; HEAD failure keeps last-good; mixed list (newest merged not owned, older closed owned → closed wins); open > merged precedence unchanged; `branchPRExec`/ancestor argv shapes include `headRefOid` / `merge-base --is-ancestor`; cached verdict avoids a second call; ancestry cache pruned for unobserved repos; update any existing tests whose merged/closed fixtures now need an oid + owned stub <!-- R1, R2, R3, R4, R5 -->
- [x] T009 [P] Tests for by-URL resolution in `app/backend/internal/prstatus/prstatus_branch_test.go`: RegisterURL wakes once; viewer-covered URL resolves with no gh call; gh path canonicalizes a run-kit URL; MERGED last-good not re-queried; transient error keeps last-good; unobserved URL ages out; `RefreshURLs` re-resolves a matching URL entry <!-- R8 -->
- [x] T010 [P] Tests in `app/backend/internal/prstatus/prstatus_test.go` (GraphQL parse carries `headRefOid` into `ViewerPR`) and `app/backend/internal/prstatus/prstatus_disk_test.go` (round-trip with and without `headRefOid`) <!-- R4 -->
- [x] T011 [P] Tests in `app/backend/internal/fabstatus/fabstatus_test.go`: `prs:` absent, `[]`, one entry, two entries (last wins), mapping instead of sequence, non-scalar items, empty-string trailing entry skipped; Change/Stage unaffected by a malformed `prs:` <!-- R6 -->
- [x] T012 Tests in `app/backend/internal/sessions/sessions_test.go`: fab-bound window with `prs:` → PrURL/PrNumber from the last entry and branch pair NOT registered; with a URL snapshot → state/draft/canonical URL overlay; fab-bound with `prs: []` → branch path; non-fab window → branch path; unparsable URL → branch path; PR-number parser cases. Run `just test-backend` until green <!-- R7, R8 -->

### Phase 4: Polish

- [x] T013 Update `docs/specs/status-pyramid.md`: L3 row source column (line ~28), invariant 6 branch-reuse note, and the D2 decision row cross-reference <!-- R9 -->
- [x] T014 Add `app/frontend/tests/demo/pr-branch-reuse.demo.ts` (file-header + per-test Proves/Steps JSDoc per the Constitution): beforeAll picks a historical MERGED hexokit PR via `gh pr list --state merged --json number,headRefName,headRefOid` (one whose head ref is not `main`), creates temp worktrees of this repo — (a) `-b <that headRefName>` at `origin/main` (reused-name case), (b) a control worktree on a second merged PR's own `headRefName`, created at that PR's head commit (`git fetch origin pull/<n>/head`, then `git worktree add -b <headRefName> <path> FETCH_HEAD`; skip/choose another PR if that branch name already exists locally) — opens rig tmux windows in each, then shows the sidebar rows and PANE register; afterAll removes the worktrees/branches. Record with `just demo pr-branch-reuse --before` and keep the printed PR-body block and `gh pr edit --attach` line for ship <!-- R10 -->

## Execution Order

- T001 blocks T002–T004 and T006 (struct fields).
- T005 blocks T007; T006 blocks T007.
- T008–T012 follow their implementation tasks; T014 needs T001–T007 built.

## Acceptance

### Functional Completeness

- [ ] A-001 R1: MERGED/CLOSED candidates are attributed only on a `--is-ancestor` exit-0 verdict; exit 1, exit 128, and empty oid are not owned
- [ ] A-002 R2: All-filtered index candidates fall through to gh; all-filtered gh results write an authoritative negative with `negativeAt`
- [ ] A-003 R3: A transient ownership/HEAD failure leaves the pair's entry byte-for-byte unchanged for that pass
- [ ] A-004 R4: `headRefOid` flows from gh `--json`, GraphQL, `ViewerPR`, index candidates, `BranchPR`, and the disk seed (optional field)
- [ ] A-005 R5: Ownership subprocesses use `exec.CommandContext` + timeout + argv, run outside `r.mu`, only for merged/closed adjudication, with HEAD resolved once per repo per pass and definite verdicts cached by `(repo, oid, head)` and pruned
- [ ] A-006 R6: `fabstatus.State.PRURL` is the last non-empty `prs:` entry; malformed input yields "" without affecting stage derivation
- [ ] A-007 R7: Fab-bound windows with a parseable `prs:` URL take identity from it and never register the branch pair; others use the branch path
- [ ] A-008 R8: Fab PR URLs are resolved off the hot path (viewer data first, then `gh pr view`), canonical URL replaces the recorded one, MERGED is terminal, and unknown state renders as ""
- [ ] A-009 R9: status-pyramid.md L3 row and invariant 6 describe both sources and the ancestry rule
- [ ] A-010 R10: `just demo pr-branch-reuse --before` produced before/after desktop+mobile videos showing the stale glyph only in `before` and the control PR in both

### Scenario Coverage

- [ ] A-011 R1: Unit tests cover the reused-name fresh-worktree case (not owned → no PR) and the genuine merged branch case (owned → purple)
- [ ] A-012 R7: Unit tests cover fab-first precedence over a branch-resolvable PR and the `prs: []` fallback
- [ ] A-013 R8: Unit tests cover the run-kit → hexokit canonicalization and the no-re-query-after-MERGED rule

### Edge Cases & Error Handling

- [ ] A-014 R1: An OPEN candidate short-circuits ownership checks entirely (no git subprocess)
- [ ] A-015 R8: gh unavailable or erroring keeps last-good URL entries; URL entries age out like branch entries

### Code Quality

- [ ] A-016 Pattern consistency: New seams, caches, and façades mirror `branchDefaultExec`/`branchOriginExec`/`Register`/`SnapshotBranchPR` naming, locking, and comment style
- [ ] A-017 No unnecessary duplication: precedence still goes through `pickBranchCandidate`; gh parsing shared between list/view where shapes match
- [ ] A-018 Go subprocesses: every new git/gh call uses `exec.CommandContext` with a timeout and an argv slice — no shell strings (Constitution I)
- [ ] A-019 Disposable daemon: no new authoritative in-memory state; caches are bounded and derivable; the SSE hot path stays zero-subprocess (Constitution II/X)
- [ ] A-020 Comments state constraints, not narration or change IDs (code-quality anti-pattern)
- [ ] A-021 Tests added for every changed behavior and run via `just test-backend`; `just build` passes

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | An existing OPEN candidate short-circuits all ownership work (open always outranks merged/closed, so their ownership cannot change the pick) | Follows from precedence; keeps the common case subprocess-free | S:75 R:90 A:85 D:80 |
| 2 | Confident | `--is-ancestor` is given the resolved HEAD sha (not the symbolic `HEAD`) so the cache key and the check describe the same commit | Avoids a race between rev-parse and the check | S:70 R:90 A:85 D:80 |
| 3 | Confident | URL-entry state source order: viewer collector URL map first (no subprocess), then `gh pr view`; MERGED is terminal (never re-queried) | Mirrors the head-index-before-gh economy; merged PRs cannot change state | S:70 R:85 A:80 D:75 |
| 4 | Confident | URL entries are not persisted to the disk seed in this change | Cold start resolves on the first wake pass; keeps the seed schema change minimal | S:60 R:90 A:75 D:70 |
| 5 | Confident | The fab path skips `prstatus.Register` for the branch pair entirely | No identity use for it; avoids needless gh work | S:75 R:90 A:80 D:80 |
| 6 | Confident | Demo control case uses a second merged PR's head fetched via `pull/<n>/head` in its own worktree, with real `gh` | Constitution § PR Evidence requires exercising the gh integration; ancestry needs the head commit locally | S:55 R:85 A:60 D:60 |

6 assumptions (0 certain, 6 confident, 0 tentative).
